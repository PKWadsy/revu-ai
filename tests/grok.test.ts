import { describe, it, expect } from "vitest";
import {
  DEFAULT_GROK_MODEL,
  buildGrokReviewArgs,
  buildGrokScaffoldArgs,
  mapGrokToolName,
  renderGrokConfigToml,
} from "../src/providers/grok.js";

describe("grok harness — config.toml rendering", () => {
  const toml = renderGrokConfigToml({
    mcpUrl: "http://127.0.0.1:54321/mcp",
    authToken: "secret-token-abc",
    ruleId: ".revu/dead-code",
  });

  it("registers the revu MCP server with the sidecar URL", () => {
    expect(toml).toContain("[mcp_servers.revu]");
    expect(toml).toContain('url = "http://127.0.0.1:54321/mcp"');
    expect(toml).toContain("enabled = true");
  });

  it("passes the bearer token and per-rule id as headers", () => {
    expect(toml).toContain("[mcp_servers.revu.headers]");
    expect(toml).toContain('Authorization = "Bearer secret-token-abc"');
    expect(toml).toContain('X-Revu-Rule-Id = ".revu/dead-code"');
  });

  it("disables auto-update and the shared leader for isolation", () => {
    expect(toml).toContain("auto_update = false");
    expect(toml).toContain("use_leader = false");
  });

  it("escapes double quotes in values to keep the TOML valid", () => {
    const t = renderGrokConfigToml({ mcpUrl: "http://x/mcp", authToken: 'a"b', ruleId: "r" });
    expect(t).toContain('Authorization = "Bearer a\\"b"');
  });
});

describe("grok harness — review argv", () => {
  const argv = buildGrokReviewArgs({
    model: "grok-4.5",
    systemPrompt: "SYS",
    userPrompt: "USER",
    repoRoot: "/repo",
  });

  it("runs a single headless prompt with streaming-json output", () => {
    expect(argv).toContain("-p");
    expect(argv).toContain("USER");
    expect(argv[argv.indexOf("--output-format") + 1]).toBe("streaming-json");
  });

  it("overrides the system prompt and pins the model + cwd", () => {
    expect(argv[argv.indexOf("--system-prompt-override") + 1]).toBe("SYS");
    expect(argv[argv.indexOf("-m") + 1]).toBe("grok-4.5");
    expect(argv[argv.indexOf("--cwd") + 1]).toBe("/repo");
  });

  it("auto-approves tools but removes file-mutating built-ins", () => {
    expect(argv).toContain("--always-approve");
    const disallowed = argv[argv.indexOf("--disallowed-tools") + 1] ?? "";
    for (const t of ["Write", "Edit", "MultiEdit", "NotebookEdit", "Patch"]) {
      expect(disallowed).toContain(t);
    }
  });

  it("denies mutating file tools and mutating git/shell commands", () => {
    const denyValues = argv.filter((_, i) => argv[i - 1] === "--deny");
    expect(denyValues).toContain("Write");
    expect(denyValues).toContain("Bash(git push:*)");
    expect(denyValues).toContain("Bash(rm:*)");
  });

  it("disables web search, subagents, plan, and memory", () => {
    for (const flag of ["--disable-web-search", "--no-subagents", "--no-plan", "--no-memory"]) {
      expect(argv).toContain(flag);
    }
  });
});

describe("grok harness — scaffold argv", () => {
  const argv = buildGrokScaffoldArgs({ model: "grok-4.5", systemPrompt: "S", userPrompt: "U", repoRoot: "/r" });
  it("removes built-in write tools (writes route through the MCP sidecar tool)", () => {
    const disallowed = argv[argv.indexOf("--disallowed-tools") + 1] ?? "";
    expect(disallowed).toContain("Write");
    expect(disallowed).toContain("Edit");
  });
});

describe("grok harness — tool name mapping", () => {
  it("normalizes built-in tool names to the shared renderer's shape", () => {
    expect(mapGrokToolName("bash")).toBe("Bash");
    expect(mapGrokToolName("read")).toBe("Read");
    expect(mapGrokToolName("grep")).toBe("Grep");
    expect(mapGrokToolName("glob")).toBe("Glob");
  });

  it("normalizes revu MCP tool variants to mcp__revu__<tool>", () => {
    expect(mapGrokToolName("mcp__revu__report_finding")).toBe("mcp__revu__report_finding");
    expect(mapGrokToolName("revu__report_finding")).toBe("mcp__revu__report_finding");
    expect(mapGrokToolName("revu_report_finding")).toBe("mcp__revu__report_finding");
    expect(mapGrokToolName("revu.report_finding")).toBe("mcp__revu__report_finding");
  });

  it("exports grok-4.5 as the default model", () => {
    expect(DEFAULT_GROK_MODEL).toBe("grok-4.5");
  });
});
