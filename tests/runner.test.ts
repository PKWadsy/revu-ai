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
function makeMockProvider(
  plan: Record<string, Array<{ severity: string; path: string; line?: number; message: string }>>,
  opts: { emitSummary?: boolean } = { emitSummary: true },
): ReviewAgentFactory {
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
        if (opts.emitSummary !== false) {
          await client.callTool({
            name: "report_review_summary",
            arguments: {
              outcome: findings.length > 0 ? "concerns" : "pass",
              checked: `mock check for ${input.ruleId}`,
              rationale: "mock rationale",
            },
          });
        }
      } finally {
        await client.close();
      }
      return { ruleId: input.ruleId, ok: true, durationMs: Date.now() - start };
    },
  });
}

/** A mock provider that records, in order, which ruleIds actually ran (i.e. weren't gated/skipped),
 *  and reports the planned findings through the real MCP sidecar like makeMockProvider does. */
function trackingProvider(
  ran: string[],
  plan: Record<string, Array<{ severity: string; path: string; line?: number; message: string }>>,
): ReviewAgentFactory {
  return (): ReviewAgent => ({
    name: "mock-track",
    async run(input: ReviewInput) {
      ran.push(input.ruleId);
      const start = Date.now();
      const findings = plan[input.ruleId] ?? [];
      const client = new Client({ name: "mock-agent", version: "0.0.1" });
      const transport = new StreamableHTTPClientTransport(new URL(input.mcp.url), {
        requestInit: { headers: { Authorization: `Bearer ${input.mcp.authToken}`, "X-Revu-Rule-Id": input.ruleId } },
      });
      try {
        await client.connect(transport);
        for (const f of findings) await client.callTool({ name: "report_finding", arguments: f });
        await client.callTool({
          name: "report_review_summary",
          arguments: { outcome: findings.length > 0 ? "concerns" : "pass", checked: "mock", rationale: "mock" },
        });
      } finally {
        await client.close();
      }
      return { ruleId: input.ruleId, ok: true, durationMs: Date.now() - start };
    },
  });
}

/** Build a full RevuConfig for the temp repo, overriding only the fields a test cares about.
 *  Mirrors loadConfig's fallback: when a test overrides `failOn` but not `gateOn`, `gateOn`
 *  follows `failOn` (the runner never re-derives this — loadConfig is the single source). */
function baseConfig(over: Partial<import("../src/types.js").RevuConfig> = {}): import("../src/types.js").RevuConfig {
  const merged: import("../src/types.js").RevuConfig = {
    pattern: "**/*.revu.md",
    harness: "mock",
    workingTree: false,
    staged: false,
    output: "json",
    failOn: "high",
    gateOn: "high",
    force: false,
    timeoutMs: 60_000,
    ...over,
  };
  if (over.gateOn === undefined) merged.gateOn = merged.failOn;
  return merged;
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
      gateOn: "high",
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

  it("propagates provider diagnostics onto the RuleResult", async () => {
    // A provider that doesn't talk to the MCP sidecar at all (0 findings) but
    // reports diagnostics indicating it emitted ~600 chars of assistant text —
    // the signal the warning surface uses to flag "model talked but didn't
    // tool-call".
    const diagnosticProvider: ReviewAgentFactory = (): ReviewAgent => ({
      name: "mock-diag",
      async run(input: ReviewInput) {
        return {
          ruleId: input.ruleId,
          ok: true,
          durationMs: 1,
          diagnostics: { textChars: 600, findingToolCalls: 0 },
        };
      },
    });
    registerHarness("mock-diag", diagnosticProvider);
    try {
      const { report } = await run(dir, {
        pattern: "**/*.revu.md",
        harness: "mock-diag",
        workingTree: false,
        staged: false,
        output: "json",
        failOn: "critical",
        gateOn: "critical",
        force: false,
        timeoutMs: 60_000,
      });
      const alpha = report.rules.find((r) => r.id === ".revu/alpha");
      expect(alpha?.diagnostics).toEqual({ textChars: 600, findingToolCalls: 0 });
      expect(alpha?.findingCount).toBe(0);
      // The mock-diag provider never talks to the MCP, so summaryCount stays 0
      // — the runner populates the field unconditionally and the pretty-output
      // banner uses it to detect incomplete reviews.
      expect(alpha?.summaryCount).toBe(0);
      expect(alpha?.checkCount).toBe(0);
    } finally {
      unregisterHarness("mock-diag");
    }
  });

  it("records report_check and report_review_summary calls in the report", async () => {
    const ackProvider: ReviewAgentFactory = (): ReviewAgent => ({
      name: "mock-ack",
      async run(input: ReviewInput) {
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
          await client.callTool({
            name: "report_check",
            arguments: { path: "src.ts", line: 1, message: `${input.ruleId} verified src.ts` },
          });
          await client.callTool({
            name: "report_review_summary",
            arguments: {
              outcome: "pass",
              checked: `inspected src.ts for ${input.ruleId}`,
              rationale: `${input.ruleId} rule is satisfied`,
            },
          });
        } finally {
          await client.close();
        }
        return { ruleId: input.ruleId, ok: true, durationMs: 1 };
      },
    });
    registerHarness("mock-ack", ackProvider);
    try {
      const { report } = await run(dir, {
        pattern: "**/*.revu.md",
        harness: "mock-ack",
        workingTree: false,
        staged: false,
        output: "json",
        failOn: "critical",
        gateOn: "critical",
        force: false,
        timeoutMs: 60_000,
      });
      const alpha = report.rules.find((r) => r.id === ".revu/alpha");
      expect(alpha?.summaryCount).toBe(1);
      expect(alpha?.checkCount).toBe(1);
      expect(report.summaries).toHaveLength(2);
      expect(report.summaries.find((s) => s.ruleId === ".revu/alpha")).toMatchObject({
        outcome: "pass",
        checked: "inspected src.ts for .revu/alpha",
      });
      expect(report.checks).toHaveLength(2);
      expect(report.checks.every((c) => c.path === "src.ts" && c.line === 1)).toBe(true);
    } finally {
      unregisterHarness("mock-ack");
    }
  });

  it("returns exit code 0 when failOn threshold is not crossed", async () => {
    const { exitCode } = await run(dir, {
      pattern: "**/*.revu.md",
      harness: "mock",
      workingTree: false,
      staged: false,
      output: "json",
      failOn: "critical",
      gateOn: "critical",
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
        schemaVersion: 3,
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
        summaries: [],
        checks: [],
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
          gateOn: "critical",
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
      gateOn: "high",
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

  it("fails rules with an empty files: pattern list", async () => {
    writeFileSync(
      join(filterDir, ".revu", "empty-files.revu.md"),
      "---\nfiles: []\n---\n# Empty files list\n",
    );
    registerHarness("mock-filter-empty", makeMockProvider({}));
    try {
      const { report } = await run(filterDir, {
        pattern: "**/empty-files.revu.md",
        harness: "mock-filter-empty",
        workingTree: false,
        staged: false,
        output: "json",
        failOn: "high",
        gateOn: "high",
        force: false,
        timeoutMs: 60_000,
      });
      const rule = report.rules.find((r) => r.id === ".revu/empty-files");
      expect(rule?.ok).toBe(false);
      expect(rule?.errorMessage).toMatch(/empty/i);
      expect(rule?.skipped).toBeUndefined();
    } finally {
      unregisterHarness("mock-filter-empty");
    }
  });
});

describe("runner — staging and gating", () => {
  it("runs stages in ascending order and gates after a stage hits the threshold", async () => {
    writeFileSync(join(dir, ".revu", "alpha.revu.md"), "---\nstage: 1\n---\n# alpha");
    writeFileSync(join(dir, ".revu", "beta.revu.md"), "---\nstage: 2\n---\n# beta");
    git(dir, "add", ".");
    git(dir, "commit", "-m", "stage rules");

    const ran: string[] = [];
    unregisterHarness("mock");
    registerHarness("mock", trackingProvider(ran, {
      ".revu/alpha": [{ severity: "high", path: "src.ts", line: 1, message: "alpha-high" }],
      ".revu/beta": [{ severity: "low", path: "src.ts", message: "beta-low" }],
    }));

    const { report, exitCode } = await run(dir, baseConfig({ failOn: "high", gateOn: "high" }));

    expect(ran).toEqual([".revu/alpha"]);
    const beta = report.rules.find((r) => r.id === ".revu/beta");
    expect(beta?.gated).toBe(true);
    expect(beta?.skipped).toBeUndefined();
    expect(report.findings.some((f) => f.ruleId === ".revu/beta")).toBe(false);
    expect(exitCode).toBe(1);
  });

  it("does NOT gate when no finding meets the gate threshold", async () => {
    writeFileSync(join(dir, ".revu", "alpha.revu.md"), "---\nstage: 1\n---\n# alpha");
    writeFileSync(join(dir, ".revu", "beta.revu.md"), "---\nstage: 2\n---\n# beta");
    git(dir, "add", ".");
    git(dir, "commit", "-m", "stage rules");

    const ran: string[] = [];
    unregisterHarness("mock");
    registerHarness("mock", trackingProvider(ran, {
      ".revu/alpha": [{ severity: "low", path: "src.ts", line: 1, message: "alpha-low" }],
      ".revu/beta": [{ severity: "low", path: "src.ts", message: "beta-low" }],
    }));

    const { report } = await run(dir, baseConfig({ failOn: "low", gateOn: "high" }));

    expect(ran.sort()).toEqual([".revu/alpha", ".revu/beta"]);
    expect(report.rules.every((r) => !r.gated)).toBe(true);
  });

  it("gateOn falls back to failOn (low) and gates aggressively", async () => {
    writeFileSync(join(dir, ".revu", "alpha.revu.md"), "---\nstage: 1\n---\n# alpha");
    writeFileSync(join(dir, ".revu", "beta.revu.md"), "---\nstage: 2\n---\n# beta");
    git(dir, "add", ".");
    git(dir, "commit", "-m", "stage rules");

    const ran: string[] = [];
    unregisterHarness("mock");
    registerHarness("mock", trackingProvider(ran, {
      ".revu/alpha": [{ severity: "low", path: "src.ts", line: 1, message: "alpha-low" }],
      ".revu/beta": [{ severity: "low", path: "src.ts", message: "beta-low" }],
    }));

    const { report } = await run(dir, baseConfig({ failOn: "low" }));

    expect(ran).toEqual([".revu/alpha"]);
    expect(report.rules.find((r) => r.id === ".revu/beta")?.gated).toBe(true);
  });

  it("treats an all-unstaged rule set as a single stage (backwards compatible)", async () => {
    const ran: string[] = [];
    unregisterHarness("mock");
    registerHarness("mock", trackingProvider(ran, {
      ".revu/alpha": [{ severity: "high", path: "src.ts", line: 1, message: "alpha-high" }],
      ".revu/beta": [{ severity: "low", path: "src.ts", message: "beta-low" }],
    }));

    const { report } = await run(dir, baseConfig({ failOn: "high", gateOn: "high" }));

    expect(ran.sort()).toEqual([".revu/alpha", ".revu/beta"]);
    expect(report.rules.every((r) => !r.gated)).toBe(true);
  });

  it("runs unstaged rules in a final stage after numbered stages", async () => {
    writeFileSync(join(dir, ".revu", "alpha.revu.md"), "---\nstage: 1\n---\n# alpha");
    git(dir, "add", ".");
    git(dir, "commit", "-m", "one staged one not");

    const order: string[] = [];
    unregisterHarness("mock");
    registerHarness("mock", trackingProvider(order, {
      ".revu/alpha": [],
      ".revu/beta": [{ severity: "low", path: "src.ts", message: "beta-low" }],
    }));

    const { report } = await run(dir, baseConfig({ failOn: "high", gateOn: "high" }));

    expect(order).toEqual([".revu/alpha", ".revu/beta"]);
    expect(report.rules.find((r) => r.id === ".revu/beta")?.gated).toBeUndefined();
  });

  it("preserves a gated rule's prior findings (no implicit resolution)", async () => {
    writeFileSync(join(dir, ".revu", "alpha.revu.md"), "---\nstage: 1\n---\n# alpha");
    writeFileSync(join(dir, ".revu", "beta.revu.md"), "---\nstage: 2\n---\n# beta");
    git(dir, "add", ".");
    git(dir, "commit", "-m", "stage rules");

    unregisterHarness("mock");
    registerHarness("mock", trackingProvider([], {
      ".revu/alpha": [{ severity: "high", path: "src.ts", line: 1, message: "alpha-high" }],
      ".revu/beta": [{ severity: "low", path: "src.ts", message: "beta-low" }],
    }));

    const priorReport: import("../src/types.js").RunReport = {
      schemaVersion: 3,
      runId: "prev",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      reviewTarget: {
        mode: "ref-range", base: "origin/main", head: "HEAD",
        baseSha: "0000000", headSha: "deadbee", changedFiles: ["src.ts"],
        target: { mode: "ref-range", base: "origin/main", head: "HEAD" },
      },
      rules: [],
      findings: [
        { ruleId: ".revu/beta", severity: "medium", path: "src.ts", line: 1, message: "beta-prior", fingerprint: "beta-prior-fp" },
      ],
      resolutions: [],
      summaries: [],
      checks: [],
    };

    const { report } = await run(dir, baseConfig({ failOn: "high", gateOn: "high" }), {}, { priorReport });

    expect(report.resolutions.some((r) => r.fingerprint === "beta-prior-fp")).toBe(false);
  });
});
