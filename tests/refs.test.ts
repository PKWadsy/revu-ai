import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTarget, isReviewEmpty } from "../src/refs.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function setup(): string {
  const dir = mkdtempSync(join(tmpdir(), "revu-refs-"));
  git(dir, "init", "-q");
  git(dir, "symbolic-ref", "HEAD", "refs/heads/main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "commit", "--allow-empty", "-m", "initial");
  git(dir, "remote", "add", "origin", dir);
  git(dir, "fetch", "origin", "-q");
  return dir;
}

describe("resolveTarget", () => {
  let dir: string;
  beforeEach(() => {
    dir = setup();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("auto-detects origin/main as base", () => {
    const r = resolveTarget(dir, { workingTree: false, staged: false });
    expect(r.target).toMatchObject({ mode: "ref-range", base: "origin/main", head: "HEAD" });
  });

  it("respects explicit --base", () => {
    const r = resolveTarget(dir, { base: "HEAD", workingTree: false, staged: false });
    expect(r.target).toMatchObject({ mode: "ref-range", base: "HEAD", head: "HEAD" });
  });

  it("returns working-tree mode when requested", () => {
    const r = resolveTarget(dir, { workingTree: true, staged: false });
    expect(r.target.mode).toBe("working-tree");
  });

  it("returns staged mode when requested", () => {
    const r = resolveTarget(dir, { workingTree: false, staged: true });
    expect(r.target.mode).toBe("staged");
  });

  it("includes baseSha and headSha for ref-range targets", () => {
    const r = resolveTarget(dir, { workingTree: false, staged: false });
    expect(r.baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(r.headSha).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("isReviewEmpty", () => {
  let dir: string;
  beforeEach(() => {
    dir = setup();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns true when there are no changes between base and HEAD", () => {
    expect(isReviewEmpty({ mode: "ref-range", base: "origin/main", head: "HEAD" }, dir)).toBe(true);
  });

  it("returns false when there's a change", () => {
    writeFileSync(join(dir, "x.txt"), "hi\n");
    git(dir, "add", "x.txt");
    git(dir, "commit", "-m", "add x");
    expect(isReviewEmpty({ mode: "ref-range", base: "origin/main", head: "HEAD" }, dir)).toBe(false);
  });
});
