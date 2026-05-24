import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSidecar } from "../src/mcp/server.js";

function clientFor(url: string, token: string, ruleId = "rule-x") {
  const c = new Client({ name: "revu-test", version: "0.0.1" });
  const t = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Revu-Rule-Id": ruleId,
      },
    },
  });
  return { client: c, transport: t };
}

describe("MCP sidecar roundtrip", () => {
  it("records a finding via the MCP protocol", async () => {
    const sidecar = await startSidecar({ repoRoot: process.cwd() });
    const client = new Client({ name: "revu-test", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(new URL(sidecar.url), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${sidecar.authToken}`,
          "X-Revu-Rule-Id": "rule-x",
        },
      },
    });
    try {
      await client.connect(transport);
      await client.callTool({
        name: "report_finding",
        arguments: {
          severity: "high",
          path: "src/foo.ts",
          line: 7,
          message: "boom",
        },
      });
      const findings = sidecar.aggregator.all();
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        ruleId: "rule-x",
        severity: "high",
        path: "src/foo.ts",
        line: 7,
      });
    } finally {
      await client.close();
      await sidecar.shutdown();
    }
  });

  it("rejects requests with the wrong bearer token", async () => {
    const sidecar = await startSidecar({ repoRoot: process.cwd() });
    try {
      const res = await fetch(sidecar.url, {
        method: "POST",
        headers: { Authorization: "Bearer wrong-token", "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      expect(res.status).toBe(401);
    } finally {
      await sidecar.shutdown();
    }
  });

  it("dedupes repeated identical findings", async () => {
    const sidecar = await startSidecar({ repoRoot: process.cwd() });
    const { client, transport } = clientFor(sidecar.url, sidecar.authToken, "rule-y");
    try {
      await client.connect(transport);
      const args = { severity: "low" as const, path: "a.ts", line: 1, message: "same" };
      await client.callTool({ name: "report_finding", arguments: args });
      await client.callTool({ name: "report_finding", arguments: args });
      expect(sidecar.aggregator.all()).toHaveLength(1);
    } finally {
      await client.close();
      await sidecar.shutdown();
    }
  });

  it("records a resolution via mark_finding_resolved", async () => {
    const sidecar = await startSidecar({ repoRoot: process.cwd() });
    const { client, transport } = clientFor(sidecar.url, sidecar.authToken, "rule-z");
    try {
      await client.connect(transport);
      await client.callTool({
        name: "mark_finding_resolved",
        arguments: { fingerprint: "abc123", reason: "fixed" },
      });
      expect(sidecar.aggregator.allResolutions()).toEqual([
        { ruleId: "rule-z", fingerprint: "abc123", reason: "fixed", resolvedAtSha: "" },
      ]);
    } finally {
      await client.close();
      await sidecar.shutdown();
    }
  });

  it("defaults mark_finding_resolved reason to `fixed` when omitted", async () => {
    const sidecar = await startSidecar({ repoRoot: process.cwd() });
    const { client, transport } = clientFor(sidecar.url, sidecar.authToken, "rule-z2");
    try {
      await client.connect(transport);
      await client.callTool({
        name: "mark_finding_resolved",
        arguments: { fingerprint: "no-reason" },
      });
      expect(sidecar.aggregator.allResolutions()[0]?.reason).toBe("fixed");
    } finally {
      await client.close();
      await sidecar.shutdown();
    }
  });

  it("records a review summary via report_review_summary", async () => {
    const sidecar = await startSidecar({ repoRoot: process.cwd() });
    const { client, transport } = clientFor(sidecar.url, sidecar.authToken, "rule-summary");
    try {
      await client.connect(transport);
      const res = await client.callTool({
        name: "report_review_summary",
        arguments: {
          outcome: "pass",
          checked: "src/foo.ts: exports unchanged",
          rationale: "no breaking change",
        },
      });
      expect((res as { isError?: boolean }).isError).toBeFalsy();
      const summary = sidecar.aggregator.summaryFor("rule-summary");
      expect(summary).toMatchObject({
        outcome: "pass",
        checked: "src/foo.ts: exports unchanged",
        rationale: "no breaking change",
      });
    } finally {
      await client.close();
      await sidecar.shutdown();
    }
  });

  it("rejects a duplicate report_review_summary for the same rule", async () => {
    const sidecar = await startSidecar({ repoRoot: process.cwd() });
    const { client, transport } = clientFor(sidecar.url, sidecar.authToken, "rule-dup-summary");
    try {
      await client.connect(transport);
      await client.callTool({
        name: "report_review_summary",
        arguments: { outcome: "pass", checked: "a", rationale: "b" },
      });
      const res2 = await client.callTool({
        name: "report_review_summary",
        arguments: { outcome: "concerns", checked: "c", rationale: "d" },
      });
      const text = (res2 as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "";
      expect(text).toMatch(/duplicate/i);
      // Only the first call wins.
      expect(sidecar.aggregator.summaryFor("rule-dup-summary")?.outcome).toBe("pass");
    } finally {
      await client.close();
      await sidecar.shutdown();
    }
  });

  it("records compliance checks via report_check", async () => {
    const sidecar = await startSidecar({ repoRoot: process.cwd() });
    const { client, transport } = clientFor(sidecar.url, sidecar.authToken, "rule-checks");
    try {
      await client.connect(transport);
      await client.callTool({
        name: "report_check",
        arguments: {
          path: "src/runner.ts",
          line: 95,
          lineEnd: 160,
          message: "filePatterns guard is local and side-effect-free",
        },
      });
      await client.callTool({
        name: "report_check",
        arguments: { path: "src/runner.ts", line: 95, lineEnd: 160, message: "filePatterns guard is local and side-effect-free" },
      });
      await client.callTool({
        name: "report_check",
        arguments: { path: "src/runner.ts", message: "no new globals introduced" },
      });
      const checks = sidecar.aggregator.checksFor("rule-checks");
      // Duplicate (same path/line/lineEnd/message) collapsed → 2 entries.
      expect(checks).toHaveLength(2);
      expect(checks[0]).toMatchObject({ ruleId: "rule-checks", line: 95, lineEnd: 160 });
    } finally {
      await client.close();
      await sidecar.shutdown();
    }
  });

  it("rejects report_check with lineEnd but no line", async () => {
    const sidecar = await startSidecar({ repoRoot: process.cwd() });
    const { client, transport } = clientFor(sidecar.url, sidecar.authToken, "rule-bad-check");
    try {
      await client.connect(transport);
      const res = await client.callTool({
        name: "report_check",
        arguments: { path: "src/x.ts", lineEnd: 10, message: "?" },
      });
      expect((res as { isError?: boolean }).isError).toBe(true);
    } finally {
      await client.close();
      await sidecar.shutdown();
    }
  });

  it("does not register write_rule_file unless the sidecar is in scaffold mode", async () => {
    const sidecar = await startSidecar({ repoRoot: process.cwd() });
    const { client, transport } = clientFor(sidecar.url, sidecar.authToken);
    try {
      await client.connect(transport);
      const res = await client.callTool({
        name: "write_rule_file",
        arguments: { path: ".revu/x.revu.md", content: "# x" },
      });
      // Either the call rejects or comes back with isError=true and a "not found"
      // text — both indicate the tool wasn't registered. Tolerate either shape.
      const r = res as { isError?: boolean; content?: Array<{ text?: string }> };
      expect(r.isError).toBe(true);
      expect(r.content?.[0]?.text ?? "").toMatch(/not found/i);
    } finally {
      await client.close();
      await sidecar.shutdown();
    }
  });
});

describe("MCP sidecar — scaffold mode (write_rule_file)", () => {
  it("writes a valid rule file and fires onFileWritten", async () => {
    const dir = mkdtempSync(join(tmpdir(), "revu-mcp-scaffold-"));
    const seen: string[] = [];
    const sidecar = await startSidecar({
      repoRoot: dir,
      scaffold: { onFileWritten: (rel) => seen.push(rel) },
    });
    const { client, transport } = clientFor(sidecar.url, sidecar.authToken, "__scaffold__");
    try {
      await client.connect(transport);
      const res = await client.callTool({
        name: "write_rule_file",
        arguments: { path: ".revu/dead-code.revu.md", content: "# dead-code reviewer\n" },
      });
      expect((res as { isError?: boolean }).isError).toBeFalsy();
      expect(seen).toEqual([".revu/dead-code.revu.md"]);
      expect(existsSync(join(dir, ".revu/dead-code.revu.md"))).toBe(true);
      expect(readFileSync(join(dir, ".revu/dead-code.revu.md"), "utf8")).toBe("# dead-code reviewer\n");
    } finally {
      await client.close();
      await sidecar.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects out-of-tree paths", async () => {
    const dir = mkdtempSync(join(tmpdir(), "revu-mcp-scaffold-"));
    const seen: string[] = [];
    const sidecar = await startSidecar({
      repoRoot: dir,
      scaffold: { onFileWritten: (rel) => seen.push(rel) },
    });
    const { client, transport } = clientFor(sidecar.url, sidecar.authToken, "__scaffold__");
    try {
      await client.connect(transport);
      const res = await client.callTool({
        name: "write_rule_file",
        arguments: { path: "../escape.revu.md", content: "# nope" },
      });
      expect((res as { isError?: boolean }).isError).toBe(true);
      expect(seen).toEqual([]);
    } finally {
      await client.close();
      await sidecar.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects non-`.revu.md` filenames", async () => {
    const dir = mkdtempSync(join(tmpdir(), "revu-mcp-scaffold-"));
    const seen: string[] = [];
    const sidecar = await startSidecar({
      repoRoot: dir,
      scaffold: { onFileWritten: (rel) => seen.push(rel) },
    });
    const { client, transport } = clientFor(sidecar.url, sidecar.authToken, "__scaffold__");
    try {
      await client.connect(transport);
      const res = await client.callTool({
        name: "write_rule_file",
        arguments: { path: ".revu/notes.txt", content: "x" },
      });
      expect((res as { isError?: boolean }).isError).toBe(true);
      expect(seen).toEqual([]);
      expect(existsSync(join(dir, ".revu/notes.txt"))).toBe(false);
    } finally {
      await client.close();
      await sidecar.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates parent directories for nested local rule files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "revu-mcp-scaffold-"));
    const sidecar = await startSidecar({
      repoRoot: dir,
      scaffold: { onFileWritten: () => {} },
    });
    const { client, transport } = clientFor(sidecar.url, sidecar.authToken, "__scaffold__");
    try {
      await client.connect(transport);
      const res = await client.callTool({
        name: "write_rule_file",
        arguments: { path: "services/auth/contract.revu.md", content: "# contract\n" },
      });
      expect((res as { isError?: boolean }).isError).toBeFalsy();
      expect(existsSync(join(dir, "services/auth/contract.revu.md"))).toBe(true);
    } finally {
      await client.close();
      await sidecar.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
