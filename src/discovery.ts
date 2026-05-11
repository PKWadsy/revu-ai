import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import fg from "fast-glob";
import ignoreImport from "ignore";
import type { RuleFile } from "./types.js";

// `ignore` is published as CJS; under NodeNext its default export is the factory itself.
const ignore = (ignoreImport as unknown as { default?: typeof ignoreImport }).default ?? ignoreImport;

// Names we always skip even if the user hasn't gitignored them. Defensive against
// repos that vendor deps or build outputs without a .gitignore entry.
const ALWAYS_IGNORE_NAMES = ["node_modules", ".git", "dist", "build"];

// fast-glob's `ignore` patterns are micromatch globs without an implicit `**/` prefix —
// `node_modules/**` only matches at the cwd root, so nested `node_modules` (workspaces,
// pnpm, vendored deps) get walked. These patterns prune at any depth.
const FG_ALWAYS_IGNORE = ALWAYS_IGNORE_NAMES.map((n) => `**/${n}`);

// Git pathspec exclusions. `:(exclude,glob)` removes paths even if they're tracked
// or not gitignored — `--exclude-standard` only applies .gitignore rules, so a tracked
// `node_modules` (rare but possible) would otherwise leak through.
const GIT_EXCLUDE_PATHSPECS = ALWAYS_IGNORE_NAMES.map((n) => `:(exclude,glob)**/${n}/**`);

export async function discoverRules(repoRoot: string, pattern: string): Promise<RuleFile[]> {
  const matches = isGitRepo(repoRoot)
    ? listFromGit(repoRoot, pattern)
    : await listFromFs(repoRoot, pattern);

  return matches.map((rel): RuleFile => {
    const abs = resolve(repoRoot, rel);
    const rawContent = readFileSync(abs, "utf8");
    const { content, filePatterns } = parseFrontmatter(rawContent);
    return {
      ruleId: deriveRuleId(rel),
      absPath: abs,
      relPath: rel,
      content,
      ...(filePatterns !== undefined ? { filePatterns } : {}),
    };
  });
}

function isGitRepo(repoRoot: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

// In a git repo, defer to git: it already honors every .gitignore source (root,
// nested, global, .git/info/exclude), respects worktree boundaries, and reads from
// the index. On a 50 GB monorepo this is orders of magnitude faster than walking
// the filesystem — git only knows about tracked files plus untracked-not-ignored,
// so traversal is bounded by repo size rather than disk size.
//
//   -c                  include tracked files
//   -o                  include untracked-not-ignored files
//   --exclude-standard  apply .gitignore + .git/info/exclude + global excludes
//   -z                  null-delimit output (safe for paths with newlines/quotes)
//   :(glob)…            opt into glob-style `**` pathspec semantics
function listFromGit(repoRoot: string, pattern: string): string[] {
  const out = execFileSync(
    "git",
    [
      "ls-files",
      "-co",
      "--exclude-standard",
      "-z",
      "--",
      `:(glob)${pattern}`,
      ...GIT_EXCLUDE_PATHSPECS,
    ],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  // `git ls-files -c` lists tracked-but-deleted-from-working-tree paths
  // (rule file deleted locally without committing the deletion). Skip those —
  // discovery's contract is "give me rule files I can read right now."
  return out
    .split("\0")
    .filter(Boolean)
    .filter((rel) => existsSync(resolve(repoRoot, rel)))
    .sort();
}

async function listFromFs(repoRoot: string, pattern: string): Promise<string[]> {
  const ig = (ignore as unknown as () => { add: (s: string) => void; ignores: (p: string) => boolean })();
  const gitignorePath = join(repoRoot, ".gitignore");
  if (existsSync(gitignorePath)) {
    ig.add(readFileSync(gitignorePath, "utf8"));
  }

  const matches = await fg(pattern, {
    cwd: repoRoot,
    dot: true,
    ignore: FG_ALWAYS_IGNORE,
    onlyFiles: true,
  });

  return matches.filter((rel) => !ig.ignores(rel)).sort();
}

function deriveRuleId(relPath: string): string {
  const withoutSuffix = relPath.replace(/\.revu\.md$/i, "");
  const parts = withoutSuffix.split(sep).filter((p) => p && p !== ".");
  return parts.join("/");
}

/**
 * Parse YAML-style frontmatter from a `.revu.md` file.
 *
 * Supports these `files:` shapes:
 *   files: "**\/*.ts"                    — single quoted string
 *   files: **\/*.ts                      — single unquoted string
 *   files: ["**\/*.ts", "**\/*.tsx"]     — inline JSON array
 *   files:
 *     - "**\/*.ts"
 *     - "**\/*.tsx"                      — YAML block list
 *
 * Returns the file content with frontmatter stripped, and the parsed patterns.
 */
export function parseFrontmatter(rawContent: string): { content: string; filePatterns?: string[] } {
  // Frontmatter must start at the very beginning of the file.
  const fmMatch = rawContent.match(/^---[ \t]*\r?\n([\s\S]*?)\n---[ \t]*(\r?\n|$)/);
  if (!fmMatch) return { content: rawContent };

  const frontmatterBlock = fmMatch[1] ?? "";
  const body = rawContent.slice(fmMatch[0].length);
  const filePatterns = parseFrontmatterFiles(frontmatterBlock);
  return { content: body, filePatterns };
}

function parseFrontmatterFiles(frontmatter: string): string[] | undefined {
  // Inline JSON array: files: ["**/*.ts", "**/*.tsx"]
  const inlineArrayMatch = frontmatter.match(/^files:\s*\[([^\]]*)\]/m);
  if (inlineArrayMatch) {
    const patterns = (inlineArrayMatch[1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
    return patterns.length > 0 ? patterns : undefined;
  }

  // YAML block list:
  //   files:
  //     - pattern1
  //     - pattern2
  const blockListMatch = frontmatter.match(/^files:\s*\r?\n((?:[ \t]+-[ \t]+.+\r?\n?)+)/m);
  if (blockListMatch) {
    const patterns = (blockListMatch[1] ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2).trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
    return patterns.length > 0 ? patterns : undefined;
  }

  // Single value: files: "pattern" or files: pattern
  const singleMatch = frontmatter.match(/^files:\s+(.+)$/m);
  if (singleMatch) {
    const val = (singleMatch[1] ?? "").trim().replace(/^["']|["']$/g, "");
    return val ? [val] : undefined;
  }

  return undefined;
}

export function _testing_deriveRuleId(rel: string): string {
  return deriveRuleId(rel);
}
