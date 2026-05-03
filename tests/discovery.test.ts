import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverRules } from "../src/discovery.js";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "revu-discovery-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });

  mkdirSync(join(dir, ".revu"), { recursive: true });
  mkdirSync(join(dir, "nested", "deep"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "junk"), { recursive: true });
  mkdirSync(join(dir, "ignored-dir"), { recursive: true });

  writeFileSync(join(dir, ".revu", "dead-code.revu.md"), "# rule");
  writeFileSync(join(dir, "nested", "deep", "thing.revu.md"), "# rule");
  writeFileSync(join(dir, "node_modules", "junk", "noisy.revu.md"), "# should be excluded");
  writeFileSync(join(dir, "ignored-dir", "skipme.revu.md"), "# in gitignore");
  writeFileSync(join(dir, ".gitignore"), "ignored-dir/\n");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("discoverRules", () => {
  it("finds rule files matching the default pattern", async () => {
    const rules = await discoverRules(dir, "**/*.revu.md");
    const ids = rules.map((r) => r.ruleId).sort();
    expect(ids).toContain(".revu/dead-code");
    expect(ids).toContain("nested/deep/thing");
  });

  it("excludes node_modules unconditionally", async () => {
    const rules = await discoverRules(dir, "**/*.revu.md");
    expect(rules.some((r) => r.relPath.includes("node_modules"))).toBe(false);
  });

  it("respects .gitignore", async () => {
    const rules = await discoverRules(dir, "**/*.revu.md");
    expect(rules.some((r) => r.relPath.includes("ignored-dir"))).toBe(false);
  });

  it("derives ruleId from path without the .revu.md suffix", async () => {
    const rules = await discoverRules(dir, "**/*.revu.md");
    const t = rules.find((r) => r.relPath.endsWith("thing.revu.md"));
    expect(t?.ruleId).toBe("nested/deep/thing");
  });

  it("loads file contents", async () => {
    const rules = await discoverRules(dir, "**/*.revu.md");
    expect(rules.every((r) => r.content.includes("rule"))).toBe(true);
  });
});
