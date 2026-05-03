import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { isAllowedRuleFileWrite } from "../src/providers/claude-code.js";

const repoRoot = resolve("/tmp/revu-allowlist-fixture");

describe("isAllowedRuleFileWrite", () => {
  it.each([
    ".revu/dead-code.revu.md",
    ".revu/error-handling.revu.md",
    "services/auth/openapi.revu.md",
    "packages/db/schema.revu.md",
    "deeply/nested/dir/something.revu.md",
  ])("allows %s", (path) => {
    expect(isAllowedRuleFileWrite(repoRoot, path)).toBe(true);
  });

  it.each([
    "package.json",
    "src/index.ts",
    "services/auth/index.ts",
    ".revu/foo.txt",          // wrong extension
    ".revu/foo.md",           // wrong extension
    "foo.revu.md.bak",        // wrong extension
    "../escape.revu.md",      // outside repo via relative
    "/etc/passwd",            // absolute outside
    "/tmp/other-repo/foo.revu.md", // absolute outside repoRoot
    "",                       // empty
  ])("rejects %s", (path) => {
    expect(isAllowedRuleFileWrite(repoRoot, path)).toBe(false);
  });

  it("allows an absolute path that resolves inside repoRoot and ends in .revu.md", () => {
    expect(isAllowedRuleFileWrite(repoRoot, `${repoRoot}/services/auth/contract.revu.md`)).toBe(true);
  });

  it("rejects a path that resolves to repoRoot itself (no filename)", () => {
    expect(isAllowedRuleFileWrite(repoRoot, repoRoot)).toBe(false);
  });

  it.each([null, undefined, 42, {}, []])("rejects non-string input %s", (v) => {
    expect(isAllowedRuleFileWrite(repoRoot, v)).toBe(false);
  });
});
