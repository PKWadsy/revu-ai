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
