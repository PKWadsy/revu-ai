import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit, InitRefusedError } from "../src/init.js";
import { registerScaffoldHarness, unregisterScaffoldHarness } from "../src/providers/registry.js";
import type { ScaffoldAgent, ScaffoldAgentFactory, ScaffoldInput } from "../src/providers/types.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function makeMockScaffold(plan: { writes: string[]; ok?: boolean; errorMessage?: string }): ScaffoldAgentFactory {
  return (): ScaffoldAgent => ({
    name: "mock",
    async run(input: ScaffoldInput) {
      // Echo the writes through the onFileWritten hook the way the real
      // provider does, so callers see live progress.
      const filesWritten: string[] = [];
      for (const rel of plan.writes) {
        filesWritten.push(rel);
        input.onFileWritten?.(rel);
      }
      return {
        ok: plan.ok ?? true,
        durationMs: 1,
        filesWritten,
        ...(plan.errorMessage ? { errorMessage: plan.errorMessage } : {}),
      };
    },
  });
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "revu-init-"));
  git(dir, "init", "-q");
  git(dir, "symbolic-ref", "HEAD", "refs/heads/main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "commit", "--allow-empty", "-m", "initial");
});

afterEach(() => {
  unregisterScaffoldHarness("mock");
  rmSync(dir, { recursive: true, force: true });
});

describe("runInit", () => {
  it("invokes the scaffold provider and reports filesWritten", async () => {
    registerScaffoldHarness(
      "mock",
      makeMockScaffold({
        writes: [".revu/dead-code.revu.md", "services/auth/contract.revu.md"],
      }),
    );

    const seen: string[] = [];
    const result = await runInit({
      cwd: dir,
      force: false,
      harness: "mock",
      timeoutMs: 1000,
      onFileWritten: (rel) => seen.push(rel),
    });

    expect(result.ok).toBe(true);
    expect(result.filesWritten).toEqual([".revu/dead-code.revu.md", "services/auth/contract.revu.md"]);
    expect(seen).toEqual([".revu/dead-code.revu.md", "services/auth/contract.revu.md"]);
    expect(result.repoRoot).toBe(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8" }).trim());
  });

  it("refuses without --force when .revu/ already contains rule files", async () => {
    registerScaffoldHarness("mock", makeMockScaffold({ writes: [] }));
    mkdirSync(join(dir, ".revu"), { recursive: true });
    writeFileSync(join(dir, ".revu", "existing.revu.md"), "# existing");

    await expect(
      runInit({
        cwd: dir,
        force: false,
        harness: "mock",
        timeoutMs: 1000,
      }),
    ).rejects.toBeInstanceOf(InitRefusedError);
  });

  it("proceeds when --force is set even if .revu/ is populated", async () => {
    registerScaffoldHarness(
      "mock",
      makeMockScaffold({ writes: [".revu/dead-code.revu.md"] }),
    );
    mkdirSync(join(dir, ".revu"), { recursive: true });
    writeFileSync(join(dir, ".revu", "existing.revu.md"), "# existing");

    const result = await runInit({
      cwd: dir,
      force: true,
      harness: "mock",
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(true);
    expect(result.filesWritten).toEqual([".revu/dead-code.revu.md"]);
  });

  it("surfaces errorMessage when the agent fails", async () => {
    registerScaffoldHarness(
      "mock",
      makeMockScaffold({ writes: [], ok: false, errorMessage: "something broke" }),
    );
    const result = await runInit({
      cwd: dir,
      force: false,
      harness: "mock",
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toBe("something broke");
  });
});
