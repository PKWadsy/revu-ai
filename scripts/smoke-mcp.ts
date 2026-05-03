/**
 * Smoke test: spin up the sidecar, connect with a real MCP client, call report_finding,
 * and verify the aggregator received it. Usage: pnpm exec tsx scripts/smoke-mcp.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startSidecar } from "../src/mcp/server.js";

async function main() {
  const sidecar = await startSidecar({ repoRoot: process.cwd() });
  console.log(`sidecar listening on ${sidecar.url}`);

  const ruleId = "smoke-test";
  const client = new Client({ name: "revu-smoke", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(sidecar.url), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${sidecar.authToken}`,
        "X-Revu-Rule-Id": ruleId,
      },
    },
  });

  await client.connect(transport);
  console.log("connected");

  const tools = await client.listTools();
  console.log("tools:", tools.tools.map((t) => t.name).join(", "));

  const ok = await client.callTool({
    name: "report_finding",
    arguments: {
      severity: "high",
      path: "src/foo.ts",
      line: 42,
      lineEnd: 47,
      message: "smoke test finding",
      category: "smoke",
    },
  });
  console.log("callTool result:", JSON.stringify(ok, null, 2));

  const dup = await client.callTool({
    name: "report_finding",
    arguments: { severity: "high", path: "src/foo.ts", line: 42, lineEnd: 47, message: "smoke test finding" },
  });
  console.log("dup result:", JSON.stringify(dup, null, 2));

  await client.close();
  await sidecar.shutdown();

  const findings = sidecar.aggregator.all();
  console.log(`aggregator collected ${findings.length} finding(s)`);
  console.log(JSON.stringify(findings, null, 2));

  if (findings.length !== 1) {
    console.error(`FAIL: expected 1 finding (dedup), got ${findings.length}`);
    process.exit(1);
  }
  if (findings[0]?.ruleId !== ruleId) {
    console.error(`FAIL: expected ruleId=${ruleId}, got ${findings[0]?.ruleId}`);
    process.exit(1);
  }
  console.log("OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
