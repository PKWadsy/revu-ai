import { readFileSync, existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import fg from "fast-glob";
import ignoreImport from "ignore";
import type { RuleFile } from "./types.js";

// `ignore` is published as CJS; under NodeNext its default export is the factory itself.
const ignore = (ignoreImport as unknown as { default?: typeof ignoreImport }).default ?? ignoreImport;

const ALWAYS_IGNORE = ["node_modules/**", ".git/**", "dist/**", "build/**"];

export async function discoverRules(repoRoot: string, pattern: string): Promise<RuleFile[]> {
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

  const filtered = matches.filter((rel) => !ig.ignores(rel));

  return filtered.map((rel): RuleFile => {
    const abs = resolve(repoRoot, rel);
    return {
      ruleId: deriveRuleId(rel),
      absPath: abs,
      relPath: rel,
      content: readFileSync(abs, "utf8"),
    };
  });
}

function deriveRuleId(relPath: string): string {
  const withoutSuffix = relPath.replace(/\.revu\.md$/i, "");
  const parts = withoutSuffix.split(sep).filter((p) => p && p !== ".");
  return parts.join("/");
}

export function _testing_deriveRuleId(rel: string): string {
  return deriveRuleId(rel);
}
