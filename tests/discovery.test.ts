import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverRules, parseFrontmatter } from "../src/discovery.js";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "revu-discovery-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });

  mkdirSync(join(dir, ".revu"), { recursive: true });
  mkdirSync(join(dir, "nested", "deep"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "junk"), { recursive: true });
  mkdirSync(join(dir, "ignored-dir"), { recursive: true });

  // Nested node_modules — the bug: the previous fast-glob pattern
  // `node_modules/**` only matched at root, so nested instances (typical of
  // workspaces / pnpm) were walked and their .revu.md files surfaced.
  mkdirSync(join(dir, "packages", "a", "node_modules", "junk"), { recursive: true });
  mkdirSync(join(dir, "packages", "a", "src"), { recursive: true });

  // Worktrees-shaped fixture — the .claude/worktrees layout that hung on Partly.
  mkdirSync(join(dir, ".claude", "worktrees", "feature-x"), { recursive: true });

  // Nested .gitignore — only the root one was honored before.
  mkdirSync(join(dir, "packages", "b", "build"), { recursive: true });
  writeFileSync(join(dir, "packages", "b", ".gitignore"), "build/\n");
  writeFileSync(join(dir, "packages", "b", "build", "in-nested-gitignore.revu.md"), "# excluded by nested .gitignore");

  writeFileSync(join(dir, ".revu", "dead-code.revu.md"), "# rule");
  writeFileSync(join(dir, "nested", "deep", "thing.revu.md"), "# rule");
  writeFileSync(join(dir, "node_modules", "junk", "noisy.revu.md"), "# should be excluded");
  writeFileSync(join(dir, "ignored-dir", "skipme.revu.md"), "# in gitignore");
  writeFileSync(join(dir, "packages", "a", "node_modules", "junk", "nested-nm.revu.md"), "# excluded by nested node_modules");
  writeFileSync(join(dir, "packages", "a", "src", "rule.revu.md"), "# rule");
  writeFileSync(join(dir, ".claude", "worktrees", "feature-x", "wt.revu.md"), "# in gitignored worktree");

  writeFileSync(join(dir, ".gitignore"), "ignored-dir/\n.claude/worktrees/\n");
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
    expect(ids).toContain("packages/a/src/rule");
  });

  it("excludes node_modules unconditionally — root and nested", async () => {
    const rules = await discoverRules(dir, "**/*.revu.md");
    expect(rules.some((r) => r.relPath.includes("node_modules"))).toBe(false);
  });

  it("respects root .gitignore", async () => {
    const rules = await discoverRules(dir, "**/*.revu.md");
    expect(rules.some((r) => r.relPath.includes("ignored-dir"))).toBe(false);
  });

  it("respects nested .gitignore (e.g. workspace package gitignoring its own build/)", async () => {
    const rules = await discoverRules(dir, "**/*.revu.md");
    expect(rules.some((r) => r.relPath.includes("in-nested-gitignore"))).toBe(false);
  });

  it("does not descend into gitignored .claude/worktrees on huge monorepos", async () => {
    const rules = await discoverRules(dir, "**/*.revu.md");
    expect(rules.some((r) => r.relPath.startsWith(".claude/worktrees"))).toBe(false);
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

describe("discoverRules — tracked but deleted in working tree", () => {
  let trackedDeleted: string;

  beforeAll(() => {
    trackedDeleted = mkdtempSync(join(tmpdir(), "revu-discovery-deleted-"));
    execFileSync("git", ["init", "-q"], { cwd: trackedDeleted });
    execFileSync("git", ["config", "user.email", "t@x"], { cwd: trackedDeleted });
    execFileSync("git", ["config", "user.name", "t"], { cwd: trackedDeleted });
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: trackedDeleted });

    mkdirSync(join(trackedDeleted, ".revu"), { recursive: true });
    writeFileSync(join(trackedDeleted, ".revu", "kept.revu.md"), "# kept");
    writeFileSync(join(trackedDeleted, ".revu", "doomed.revu.md"), "# doomed");
    execFileSync("git", ["add", "."], { cwd: trackedDeleted });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: trackedDeleted });

    // Delete from working tree without staging the deletion. `git ls-files -c`
    // still lists `doomed.revu.md`; we should skip it.
    rmSync(join(trackedDeleted, ".revu", "doomed.revu.md"));
  });

  afterAll(() => {
    rmSync(trackedDeleted, { recursive: true, force: true });
  });

  it("skips paths that exist in the index but not in the working tree", async () => {
    const rules = await discoverRules(trackedDeleted, "**/*.revu.md");
    const ids = rules.map((r) => r.ruleId);
    expect(ids).toContain(".revu/kept");
    expect(ids).not.toContain(".revu/doomed");
  });
});

describe("discoverRules — non-git fallback", () => {
  let nogit: string;

  beforeAll(() => {
    nogit = mkdtempSync(join(tmpdir(), "revu-discovery-nogit-"));
    mkdirSync(join(nogit, "node_modules", "deep"), { recursive: true });
    mkdirSync(join(nogit, "packages", "a", "node_modules", "junk"), { recursive: true });
    mkdirSync(join(nogit, "packages", "a", "src"), { recursive: true });
    mkdirSync(join(nogit, "dist", "x"), { recursive: true });

    writeFileSync(join(nogit, "packages", "a", "src", "ok.revu.md"), "# rule");
    writeFileSync(join(nogit, "node_modules", "deep", "skip.revu.md"), "# skip");
    writeFileSync(join(nogit, "packages", "a", "node_modules", "junk", "nested-nm.revu.md"), "# skip");
    writeFileSync(join(nogit, "dist", "x", "skip.revu.md"), "# skip");
  });

  afterAll(() => {
    rmSync(nogit, { recursive: true, force: true });
  });

  it("excludes nested node_modules / dist / build via traversal pruning", async () => {
    const rules = await discoverRules(nogit, "**/*.revu.md");
    expect(rules.some((r) => r.relPath.includes("node_modules"))).toBe(false);
    expect(rules.some((r) => r.relPath.startsWith("dist/"))).toBe(false);
    expect(rules.some((r) => r.relPath.endsWith("ok.revu.md"))).toBe(true);
  });
});

describe("parseFrontmatter", () => {
  it("returns content unchanged when there is no frontmatter", () => {
    const raw = "# My rule\n\nSome content.\n";
    const { content, filePatterns } = parseFrontmatter(raw);
    expect(content).toBe(raw);
    expect(filePatterns).toBeUndefined();
  });

  it("strips frontmatter and returns the body", () => {
    const raw = '---\nfiles: "**/*.ts"\n---\n# My rule\n\nContent.\n';
    const { content, filePatterns } = parseFrontmatter(raw);
    expect(content).toBe("# My rule\n\nContent.\n");
    expect(filePatterns).toEqual(["**/*.ts"]);
  });

  it("parses a single unquoted files: value", () => {
    const raw = "---\nfiles: **/*.py\n---\n# Rule\n";
    const { filePatterns } = parseFrontmatter(raw);
    expect(filePatterns).toEqual(["**/*.py"]);
  });

  it("parses an inline JSON array for files:", () => {
    const raw = '---\nfiles: ["**/*.ts", "**/*.tsx"]\n---\n# Rule\n';
    const { filePatterns } = parseFrontmatter(raw);
    expect(filePatterns).toEqual(["**/*.ts", "**/*.tsx"]);
  });

  it("parses a YAML block list for files:", () => {
    const raw = "---\nfiles:\n  - src/**/*.ts\n  - tests/**/*.ts\n---\n# Rule\n";
    const { filePatterns } = parseFrontmatter(raw);
    expect(filePatterns).toEqual(["src/**/*.ts", "tests/**/*.ts"]);
  });

  it("returns undefined filePatterns when files: is absent from frontmatter", () => {
    const raw = "---\ntitle: My rule\n---\n# Rule\n";
    const { filePatterns } = parseFrontmatter(raw);
    expect(filePatterns).toBeUndefined();
  });

  it("ignores frontmatter that does not start at the very beginning", () => {
    const raw = "\n---\nfiles: **/*.ts\n---\n# Rule\n";
    const { content, filePatterns } = parseFrontmatter(raw);
    expect(content).toBe(raw);
    expect(filePatterns).toBeUndefined();
  });
});

describe("discoverRules — filePatterns from frontmatter", () => {
  let fmDir: string;

  beforeAll(() => {
    fmDir = mkdtempSync(join(tmpdir(), "revu-discovery-fm-"));
    execFileSync("git", ["init", "-q"], { cwd: fmDir });
    mkdirSync(join(fmDir, ".revu"), { recursive: true });

    // Rule with files: frontmatter
    writeFileSync(
      join(fmDir, ".revu", "ts-only.revu.md"),
      '---\nfiles: "**/*.ts"\n---\n# TS rule\n',
    );
    // Rule without frontmatter
    writeFileSync(join(fmDir, ".revu", "all-files.revu.md"), "# All files rule\n");
  });

  afterAll(() => {
    rmSync(fmDir, { recursive: true, force: true });
  });

  it("populates filePatterns for rules with files: frontmatter", async () => {
    const rules = await discoverRules(fmDir, "**/*.revu.md");
    const tsRule = rules.find((r) => r.ruleId === ".revu/ts-only");
    expect(tsRule?.filePatterns).toEqual(["**/*.ts"]);
  });

  it("omits filePatterns for rules without files: frontmatter", async () => {
    const rules = await discoverRules(fmDir, "**/*.revu.md");
    const allRule = rules.find((r) => r.ruleId === ".revu/all-files");
    expect(allRule?.filePatterns).toBeUndefined();
  });

  it("strips frontmatter from content", async () => {
    const rules = await discoverRules(fmDir, "**/*.revu.md");
    const tsRule = rules.find((r) => r.ruleId === ".revu/ts-only");
    expect(tsRule?.content).toBe("# TS rule\n");
    expect(tsRule?.content).not.toContain("---");
  });
});
