import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/runner.js";
import { registerHarness, unregisterHarness } from "../src/providers/registry.js";
import type { ReviewAgent, ReviewAgentFactory, ReviewInput } from "../src/providers/types.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Mock provider that talks to the runner-provided MCP sidecar over the real wire,
 * so we exercise everything except the actual Claude agent.
 */
function makeMockProvider(plan: Record<string, Array<{ severity: string; path: string; line?: number; message: string }>>): ReviewAgentFactory {
  return (): ReviewAgent => ({
    name: "mock",
    async run(input: ReviewInput) {
      const start = Date.now();
      const findings = plan[input.ruleId] ?? [];
      const client = new Client({ name: "mock-agent", version: "0.0.1" });
      const transport = new StreamableHTTPClientTransport(new URL(input.mcp.url), {
        requestInit: {
          headers: {
            Authorization: `Bearer ${input.mcp.authToken}`,
            "X-Revu-Rule-Id": input.ruleId,
          },
        },
      });
      try {
        await client.connect(transport);
        for (const f of findings) {
          await client.callTool({ name: "report_finding", arguments: f });
        }
      } finally {
        await client.close();
      }
      return { ruleId: input.ruleId, ok: true, durationMs: Date.now() - start };
    },
  });
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "revu-runner-"));
  git(dir, "init", "-q");
  git(dir, "symbolic-ref", "HEAD", "refs/heads/main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "commit", "--allow-empty", "-m", "initial");
  git(dir, "remote", "add", "origin", dir);
  git(dir, "fetch", "origin", "-q");

  // Add rule files + a real change so the pre-flight skip doesn't short-circuit.
  mkdirSync(join(dir, ".revu"), { recursive: true });
  writeFileSync(join(dir, ".revu", "alpha.revu.md"), "# alpha");
  writeFileSync(join(dir, ".revu", "beta.revu.md"), "# beta");
  writeFileSync(join(dir, "src.ts"), "console.log('hi');\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "feat");

  registerHarness("mock", makeMockProvider({
    ".revu/alpha": [
      { severity: "high", path: "src.ts", line: 1, message: "alpha-finding" },
      { severity: "high", path: "src.ts", line: 1, message: "alpha-finding" }, // dup
    ],
    ".revu/beta": [
      { severity: "low", path: "src.ts", message: "beta-finding" },
    ],
  }));
});

afterEach(() => {
  unregisterHarness("mock");
  rmSync(dir, { recursive: true, force: true });
});

describe("runner", () => {
  it("orchestrates discovery, fan-out, and aggregation", async () => {
    const { report, exitCode } = await run(dir, {
      pattern: "**/*.revu.md",
      harness: "mock",
      workingTree: false,
      staged: false,
      output: "json",
      failOn: "high",
      force: false,
      timeoutMs: 60_000,
    });

    expect(report.rules.map((r) => r.id).sort()).toEqual([".revu/alpha", ".revu/beta"]);
    expect(report.rules.every((r) => r.ok)).toBe(true);

    // alpha had a duplicate finding; aggregator should have deduped it.
    const alphaFindings = report.findings.filter((f) => f.ruleId === ".revu/alpha");
    expect(alphaFindings).toHaveLength(1);
    expect(alphaFindings[0]).toMatchObject({ severity: "high", path: "src.ts", line: 1 });

    const betaFindings = report.findings.filter((f) => f.ruleId === ".revu/beta");
    expect(betaFindings).toHaveLength(1);

    // exitCode 1 because there's a high finding and failOn=high.
    expect(exitCode).toBe(1);
  });

  it("returns exit code 0 when failOn threshold is not crossed", async () => {
    const { exitCode } = await run(dir, {
      pattern: "**/*.revu.md",
      harness: "mock",
      workingTree: false,
      staged: false,
      output: "json",
      failOn: "critical",
      force: false,
      timeoutMs: 60_000,
    });
    expect(exitCode).toBe(0);
  });
});

describe("runner — priorReport flow", () => {
  it("groups prior findings by ruleId, filters resolved ones, surfaces resolutions", async () => {
    // Capture what each mock agent receives, plus simulate resolving one prior finding.
    const seen: Record<string, { priorFp: string[]; priorHeadSha?: string | undefined }> = {};
    const captureProvider: ReviewAgentFactory = (): ReviewAgent => ({
      name: "mock-prior",
      async run(input: ReviewInput) {
        seen[input.ruleId] = {
          priorFp: (input.priorFindings ?? []).map((f) => f.fingerprint),
          priorHeadSha: input.priorHeadSha,
        };

        const client = new Client({ name: "mock-agent", version: "0.0.1" });
        const transport = new StreamableHTTPClientTransport(new URL(input.mcp.url), {
          requestInit: {
            headers: {
              Authorization: `Bearer ${input.mcp.authToken}`,
              "X-Revu-Rule-Id": input.ruleId,
            },
          },
        });
        try {
          await client.connect(transport);
          // alpha agent resolves its prior open finding; beta does nothing.
          if (input.ruleId === ".revu/alpha" && input.priorFindings?.[0]) {
            await client.callTool({
              name: "mark_finding_resolved",
              arguments: { fingerprint: input.priorFindings[0].fingerprint, reason: "fixed" },
            });
          }
        } finally {
          await client.close();
        }
        return { ruleId: input.ruleId, ok: true, durationMs: 1 };
      },
    });
    registerHarness("mock-prior", captureProvider);

    try {
      const priorReport: import("../src/types.js").RunReport = {
        schemaVersion: 2,
        runId: "prev-run",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        reviewTarget: {
          mode: "ref-range",
          base: "origin/main",
          head: "HEAD",
          baseSha: "0000000",
          headSha: "deadbee",
          changedFiles: ["src.ts"],
          target: { mode: "ref-range", base: "origin/main", head: "HEAD" },
        },
        rules: [],
        findings: [
          // alpha: one open prior, one already-resolved-by-prior (must be filtered out).
          { ruleId: ".revu/alpha", severity: "high", path: "src.ts", line: 1, message: "old-open", fingerprint: "alpha-open-fp" },
          { ruleId: ".revu/alpha", severity: "low", path: "src.ts", line: 9, message: "already-resolved", fingerprint: "alpha-stale-fp" },
          // beta: one open prior.
          { ruleId: ".revu/beta", severity: "medium", path: "src.ts", line: 1, message: "beta-prior", fingerprint: "beta-open-fp" },
        ],
        resolutions: [
          { ruleId: ".revu/alpha", fingerprint: "alpha-stale-fp", reason: "fixed", resolvedAtSha: "deadbee" },
        ],
      };

      const { report } = await run(
        dir,
        {
          pattern: "**/*.revu.md",
          harness: "mock-prior",
          workingTree: false,
          staged: false,
          output: "json",
          failOn: "critical",
          force: false,
          timeoutMs: 60_000,
        },
        {},
        { priorReport },
      );

      // alpha agent saw exactly the 1 open prior finding (the resolved one was filtered).
      expect(seen[".revu/alpha"]?.priorFp).toEqual(["alpha-open-fp"]);
      // beta agent saw its own prior finding, scoped per-rule.
      expect(seen[".revu/beta"]?.priorFp).toEqual(["beta-open-fp"]);
      // priorHeadSha threaded through to both agents.
      expect(seen[".revu/alpha"]?.priorHeadSha).toBe("deadbee");
      expect(seen[".revu/beta"]?.priorHeadSha).toBe("deadbee");

      // The runner's output report records the new resolution emitted by alpha.
      const alphaResolution = report.resolutions.find(
        (r) => r.ruleId === ".revu/alpha" && r.fingerprint === "alpha-open-fp",
      );
      expect(alphaResolution).toBeDefined();
      expect(alphaResolution?.reason).toBe("fixed");
    } finally {
      unregisterHarness("mock-prior");
    }
  });
});

describe("runner — filePatterns filtering", () => {
  let filterDir: string;

  beforeEach(() => {
    filterDir = mkdtempSync(join(tmpdir(), "revu-runner-filter-"));
    git(filterDir, "init", "-q");
    git(filterDir, "symbolic-ref", "HEAD", "refs/heads/main");
    git(filterDir, "config", "user.email", "test@example.com");
    git(filterDir, "config", "user.name", "Test");
    git(filterDir, "commit", "--allow-empty", "-m", "initial");
    git(filterDir, "remote", "add", "origin", filterDir);
    git(filterDir, "fetch", "origin", "-q");

    mkdirSync(join(filterDir, ".revu"), { recursive: true });
    // Rule scoped to .ts files only (via frontmatter)
    writeFileSync(
      join(filterDir, ".revu", "ts-rule.revu.md"),
      '---\nfiles: "**/*.ts"\n---\n# TS rule\n',
    );
    // Rule with no file filter
    writeFileSync(join(filterDir, ".revu", "all-rule.revu.md"), "# All files rule\n");
    // Change only a .py file — ts-rule should be skipped
    writeFileSync(join(filterDir, "script.py"), "print('hello')\n");
    git(filterDir, "add", ".");
    git(filterDir, "commit", "-m", "feat");

    registerHarness("mock-filter", makeMockProvider({
      ".revu/ts-rule": [
        { severity: "high", path: "script.py", message: "should-not-appear" },
      ],
      ".revu/all-rule": [
        { severity: "low", path: "script.py", message: "all-rule-finding" },
      ],
    }));
  });

  afterEach(() => {
    unregisterHarness("mock-filter");
    rmSync(filterDir, { recursive: true, force: true });
  });

  it("skips rules whose filePatterns do not match any changed files", async () => {
    const { report } = await run(filterDir, {
      pattern: "**/*.revu.md",
      harness: "mock-filter",
      workingTree: false,
      staged: false,
      output: "json",
      failOn: "high",
      force: false,
      timeoutMs: 60_000,
    });

    // ts-rule should be marked skipped, not run.
    const tsRule = report.rules.find((r) => r.id === ".revu/ts-rule");
    expect(tsRule?.skipped).toBe(true);
    expect(tsRule?.ok).toBe(true);

    // all-rule should have run and produced a finding.
    const allRule = report.rules.find((r) => r.id === ".revu/all-rule");
    expect(allRule?.skipped).toBeUndefined();
    expect(allRule?.ok).toBe(true);

    // No findings from ts-rule since it was skipped.
    expect(report.findings.some((f) => f.ruleId === ".revu/ts-rule")).toBe(false);
    // all-rule finding should be present.
    expect(report.findings.some((f) => f.ruleId === ".revu/all-rule")).toBe(true);
  });
});
