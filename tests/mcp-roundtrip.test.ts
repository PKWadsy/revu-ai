import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startSidecar } from "../src/mcp/server.js";

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
    const client = new Client({ name: "revu-test", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(new URL(sidecar.url), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${sidecar.authToken}`,
          "X-Revu-Rule-Id": "rule-y",
        },
      },
    });
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
});
