import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runForgePost } from "../../src/forges/post-cmd.js";
import { registerForge, unregisterForge } from "../../src/forges/registry.js";
import type { ForgeAdapter, ForgeAdapterFactory, PostOptions, PostResult } from "../../src/forges/types.js";
import type { RunReport } from "../../src/types.js";

const VALID_REPORT: RunReport = {
  schemaVersion: 2,
  runId: "run-1",
  startedAt: new Date(0).toISOString(),
  completedAt: new Date(0).toISOString(),
  reviewTarget: {
    mode: "ref-range",
    base: "origin/main",
    head: "HEAD",
    baseSha: "0".repeat(40),
    headSha: "1".repeat(40),
    changedFiles: ["src/foo.ts"],
    target: { mode: "ref-range", base: "origin/main", head: "HEAD" },
  },
  rules: [],
  findings: [],
  resolutions: [],
};

interface MockState {
  posts: PostOptions[];
  result: PostResult;
}

function makeMockForge(state: MockState): ForgeAdapterFactory {
  return (): ForgeAdapter => ({
    name: "mock-forge",
    async resolveContext() {
      return {
        repo: { owner: "o", name: "r" },
        pr: 42,
        headSha: "1".repeat(40),
        token: "t",
      };
    },
    async post(opts: PostOptions) {
      state.posts.push(opts);
      return state.result;
    },
  });
}

let dir: string;
let state: MockState;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "revu-post-cmd-"));
  state = {
    posts: [],
    result: {
      inline: { posted: 0, skipped: 0 },
      body: { posted: 0, skipped: 0 },
      patchesResolved: 0,
      patchesMoved: 0,
      totalFindings: 0,
      event: "comment",
      augmentedReport: VALID_REPORT,
    },
  };
  registerForge("mock-forge", makeMockForge(state));
});

afterEach(() => {
  unregisterForge("mock-forge");
  rmSync(dir, { recursive: true, force: true });
});

describe("runForgePost", () => {
  it("rejects reports with an unsupported schemaVersion", async () => {
    const reportPath = join(dir, "report.json");
    writeFileSync(reportPath, JSON.stringify({ ...VALID_REPORT, schemaVersion: 99 }));

    await expect(
      runForgePost({
        forge: "mock-forge",
        reportPath,
        flags: {},
        dryRun: false,
      }),
    ).rejects.toThrow(/schemaVersion 99/);
  });

  it("accepts schemaVersion 1 (the v1 contract is still supported)", async () => {
    const reportPath = join(dir, "report.json");
    writeFileSync(reportPath, JSON.stringify({ ...VALID_REPORT, schemaVersion: 1 }));

    await expect(
      runForgePost({
        forge: "mock-forge",
        reportPath,
        flags: {},
        dryRun: false,
      }),
    ).resolves.toBeDefined();
    expect(state.posts).toHaveLength(1);
  });

  it("tolerates a missing prior report (ENOENT) by proceeding without one", async () => {
    const reportPath = join(dir, "report.json");
    writeFileSync(reportPath, JSON.stringify(VALID_REPORT));

    await runForgePost({
      forge: "mock-forge",
      reportPath,
      priorReportPath: join(dir, "does-not-exist.json"),
      flags: {},
      dryRun: false,
    });

    expect(state.posts).toHaveLength(1);
    expect(state.posts[0]?.priorReport).toBeUndefined();
  });

  it("rejects an existing prior report with an unsupported schemaVersion", async () => {
    const reportPath = join(dir, "report.json");
    const priorPath = join(dir, "prior.json");
    writeFileSync(reportPath, JSON.stringify(VALID_REPORT));
    writeFileSync(priorPath, JSON.stringify({ ...VALID_REPORT, schemaVersion: 99 }));

    await expect(
      runForgePost({
        forge: "mock-forge",
        reportPath,
        priorReportPath: priorPath,
        flags: {},
        dryRun: false,
      }),
    ).rejects.toThrow(/prior report schemaVersion 99/);
  });

  it("threads the prior report into the forge adapter when present and valid", async () => {
    const reportPath = join(dir, "report.json");
    const priorPath = join(dir, "prior.json");
    writeFileSync(reportPath, JSON.stringify(VALID_REPORT));
    writeFileSync(priorPath, JSON.stringify({ ...VALID_REPORT, runId: "prior-run" }));

    await runForgePost({
      forge: "mock-forge",
      reportPath,
      priorReportPath: priorPath,
      flags: {},
      dryRun: false,
    });

    expect(state.posts[0]?.priorReport?.runId).toBe("prior-run");
  });

  it("writes the augmented report to outputFile when set", async () => {
    const reportPath = join(dir, "report.json");
    const outputFile = join(dir, "augmented.json");
    writeFileSync(reportPath, JSON.stringify(VALID_REPORT));

    state.result.augmentedReport = {
      ...VALID_REPORT,
      runId: "augmented-run-id",
    };

    await runForgePost({
      forge: "mock-forge",
      reportPath,
      outputFile,
      flags: {},
      dryRun: false,
    });

    const written = JSON.parse(readFileSync(outputFile, "utf8")) as RunReport;
    expect(written.runId).toBe("augmented-run-id");
  });

  it("creates parent directories implicitly via outputFile (does not — caller's job)", async () => {
    // Documented expectation: outputFile's parent must exist. This test pins
    // the contract so a future refactor doesn't accidentally start mkdir'ing.
    const reportPath = join(dir, "report.json");
    const outputFile = join(dir, "missing-dir", "augmented.json");
    writeFileSync(reportPath, JSON.stringify(VALID_REPORT));

    await expect(
      runForgePost({
        forge: "mock-forge",
        reportPath,
        outputFile,
        flags: {},
        dryRun: false,
      }),
    ).rejects.toThrow();
  });

  it("reads the report from stdin when reportPath is `-`", async () => {
    const stdinReport = { ...VALID_REPORT, runId: "from-stdin" };

    await runForgePost({
      forge: "mock-forge",
      reportPath: "-",
      flags: {},
      dryRun: false,
      readStdin: async () => JSON.stringify(stdinReport),
    });

    expect(state.posts[0]?.report.runId).toBe("from-stdin");
  });

  it("forwards requestChangesAtOrAbove and dryRun to the adapter unchanged", async () => {
    const reportPath = join(dir, "report.json");
    writeFileSync(reportPath, JSON.stringify(VALID_REPORT));

    await runForgePost({
      forge: "mock-forge",
      reportPath,
      flags: {},
      requestChangesAtOrAbove: "high",
      dryRun: true,
    });

    expect(state.posts[0]?.dryRun).toBe(true);
    expect(state.posts[0]?.requestChangesAtOrAbove).toBe("high");
  });

  it("uses an injected env when provided (resolveContext sees it)", async () => {
    const reportPath = join(dir, "report.json");
    writeFileSync(reportPath, JSON.stringify(VALID_REPORT));

    let seenEnv: NodeJS.ProcessEnv | undefined;
    registerForge("env-spy", () => ({
      name: "env-spy",
      async resolveContext(env) {
        seenEnv = env;
        return { repo: { owner: "o", name: "r" }, pr: 1, headSha: "x", token: "t" };
      },
      async post() {
        return state.result;
      },
    }));

    try {
      await runForgePost({
        forge: "env-spy",
        reportPath,
        flags: {},
        dryRun: false,
        env: { CUSTOM_VAR: "marker" } as NodeJS.ProcessEnv,
      });
      expect(seenEnv?.["CUSTOM_VAR"]).toBe("marker");
    } finally {
      unregisterForge("env-spy");
    }
  });
});
