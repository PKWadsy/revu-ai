import { isAbsolute, relative, resolve } from "node:path";

/**
 * The scaffold agent is allowed to write rule files, but only `.revu.md` files
 * that resolve to a path inside the repo root. Anything else must be rejected
 * by whatever code is enforcing the write (canUseTool callback for claude-code,
 * the MCP `write_rule_file` tool for opencode).
 */
export function isAllowedRuleFileWrite(repoRoot: string, filePath: unknown): boolean {
  if (typeof filePath !== "string" || filePath.length === 0) return false;
  if (!/\.revu\.md$/.test(filePath)) return false;
  const abs = isAbsolute(filePath) ? filePath : resolve(repoRoot, filePath);
  const rel = relative(resolve(repoRoot), abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
  return true;
}

/** Normalize a (possibly absolute) `.revu.md` path to a repo-relative,
 *  forward-slash path. Caller must have already passed `isAllowedRuleFileWrite`. */
export function toRepoRelative(repoRoot: string, filePath: string): string {
  const abs = isAbsolute(filePath) ? filePath : resolve(repoRoot, filePath);
  return relative(resolve(repoRoot), abs).split("\\").join("/");
}
