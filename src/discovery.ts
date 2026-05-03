import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import fg from "fast-glob";
import ignoreImport from "ignore";
import type { RuleFile } from "./types.js";

// `ignore` is published as CJS; under NodeNext its default export is the factory itself.
const ignore = (ignoreImport as unknown as { default?: typeof ignoreImport }).default ?? ignoreImport;

// fast-glob's `ignore` patterns are micromatch globs without an implicit `**/` prefix —
// `node_modules/**` only matches at the cwd root, so nested `node_modules` (workspaces,
// pnpm, vendored deps) get walked. These patterns prune at any depth.
const ALWAYS_IGNORE = [
  "**/node_modules",
  "**/.git",
  "**/dist",
  "**/build",
];

export async function discoverRules(repoRoot: string, pattern: string): Promise<RuleFile[]> {
  const matches = isGitRepo(repoRoot)
    ? listFromGit(repoRoot, pattern)
    : await listFromFs(repoRoot, pattern);

  return matches.map((rel): RuleFile => {
    const abs = resolve(repoRoot, rel);
    return {
      ruleId: deriveRuleId(rel),
      absPath: abs,
      relPath: rel,
      content: readFileSync(abs, "utf8"),
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
    ["ls-files", "-co", "--exclude-standard", "-z", "--", `:(glob)${pattern}`],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  return out.split("\0").filter(Boolean).sort();
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
    ignore: ALWAYS_IGNORE,
    onlyFiles: true,
  });

  return matches.filter((rel) => !ig.ignores(rel)).sort();
}

function deriveRuleId(relPath: string): string {
  const withoutSuffix = relPath.replace(/\.revu\.md$/i, "");
  const parts = withoutSuffix.split(sep).filter((p) => p && p !== ".");
  return parts.join("/");
}

export function _testing_deriveRuleId(rel: string): string {
  return deriveRuleId(rel);
}
