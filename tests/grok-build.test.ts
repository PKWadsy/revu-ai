import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_GROK_BUILD_MODEL,
  accumulateGrokStreamEvent,
  buildGrokHomeConfig,
  formatGrokBinaryError,
  rewriteMcpToolNamesForGrok,
  resolveGrokModel,
  __setGrokBinaryForTests,
  grokBuildProvider,
} from "../src/providers/grok-build.js";
import type { ReviewDiagnostics } from "../src/providers/types.js";

describe("resolveGrokModel", () => {
  it("defaults to grok-build (Grok 4.5)", () => {
    expect(resolveGrokModel({})).toBe(DEFAULT_GROK_BUILD_MODEL);
    expect(DEFAULT_GROK_BUILD_MODEL).toBe("grok-build");
  });

  it("honors an explicit --model override", () => {
    expect(resolveGrokModel({ model: "grok-4.5" })).toBe("grok-4.5");
  });
});

describe("buildGrokHomeConfig", () => {
  it("declares the revu MCP server with auth + rule headers", () => {
    const toml = buildGrokHomeConfig({
      mcpUrl: "http://127.0.0.1:4242/mcp",
      authToken: "tok-abc",
      ruleId: "dead-code",
      model: "grok-build",
    });
    expect(toml).toContain("[mcp_servers.revu]");
    expect(toml).toContain('url = "http://127.0.0.1:4242/mcp"');
    expect(toml).toContain("Authorization");
    expect(toml).toContain("Bearer tok-abc");
    expect(toml).toContain("X-Revu-Rule-Id");
    expect(toml).toContain("dead-code");
    expect(toml).toContain('default = "grok-build"');
    expect(toml).toContain("auto_update = false");
  });

  it("registers a custom API model id under [model.<id>] so catalog lag cannot reject it", () => {
    const toml = buildGrokHomeConfig({
      mcpUrl: "http://127.0.0.1:1/mcp",
      authToken: "t",
      ruleId: "r",
      model: "grok-4.5",
    });
    expect(toml).toContain('[model."grok-4.5"]');
    expect(toml).toContain('model = "grok-4.5"');
    expect(toml).toContain('env_key = "XAI_API_KEY"');
    expect(toml).toContain('api_backend = "responses"');
  });
});

describe("rewriteMcpToolNamesForGrok", () => {
  it("maps Claude-style mcp__revu__* names to Grok Build's revu__* namespace", () => {
    const input =
      "Call `mcp__revu__report_finding` then `mcp__revu__report_review_summary` and `mcp__revu__mark_finding_open`.";
    const out = rewriteMcpToolNamesForGrok(input);
    expect(out).toContain("`revu__report_finding`");
    expect(out).toContain("`revu__report_review_summary`");
    expect(out).toContain("`revu__mark_finding_open`");
    expect(out).not.toContain("mcp__revu__");
  });
});

describe("accumulateGrokStreamEvent", () => {
  function fresh(): ReviewDiagnostics {
    return { textChars: 0, findingToolCalls: 0 };
  }

  it("counts text event characters", () => {
    const d = fresh();
    const activities: Array<{ kind: string; detail: string }> = [];
    accumulateGrokStreamEvent(
      { type: "text", data: "  hello world  " },
      d,
      (a) => activities.push(a),
    );
    expect(d.textChars).toBe("hello world".length);
    expect(activities[0]?.kind).toBe("text");
  });

  it("ignores thought / end / unknown events for diagnostics", () => {
    const d = fresh();
    accumulateGrokStreamEvent({ type: "thought", data: "planning…" }, d);
    accumulateGrokStreamEvent({ type: "end", stopReason: "EndTurn" }, d);
    accumulateGrokStreamEvent({ type: "weird" }, d);
    expect(d).toEqual({ textChars: 0, findingToolCalls: 0 });
  });

  it("surfaces error events via the returned message", () => {
    const d = fresh();
    const msg = accumulateGrokStreamEvent(
      { type: "error", message: "Couldn't start session: boom" },
      d,
    );
    expect(msg).toBe("Couldn't start session: boom");
  });
});

describe("formatGrokBinaryError", () => {
  it("explains how to install when the binary is missing", () => {
    const msg = formatGrokBinaryError(Object.assign(new Error("spawn grok ENOENT"), { code: "ENOENT" }));
    expect(msg).toMatch(/grok binary not found/i);
    expect(msg).toMatch(/x\.ai\/cli|@xai-official\/grok/);
  });
});

describe("grokBuildProvider.run (subprocess)", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    __setGrokBinaryForTests(undefined);
    for (const d of tmpDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    tmpDirs.length = 0;
  });

  function makeFakeGrok(scriptBody: string): string {
    const dir = mkdtempSync(join(tmpdir(), "revu-fake-grok-"));
    tmpDirs.push(dir);
    const bin = join(dir, "grok");
    writeFileSync(bin, `#!/usr/bin/env node\n${scriptBody}\n`, { mode: 0o755 });
    return bin;
  }

  it("writes an isolated GROK_HOME, passes headless flags, and succeeds on end event", async () => {
    const captureDir = mkdtempSync(join(tmpdir(), "revu-grok-capture-"));
    tmpDirs.push(captureDir);
    const capturePath = join(captureDir, "argv.json");

    const fake = makeFakeGrok(`
      const fs = require("node:fs");
      const path = require("node:path");
      const grokHome = process.env.GROK_HOME || "";
      const configToml = grokHome
        ? fs.readFileSync(path.join(grokHome, "config.toml"), "utf8")
        : "";
      fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
        argv: process.argv.slice(2),
        grokHome,
        cwd: process.cwd(),
        configToml,
      }));
      // Emit a successful streaming-json session.
      process.stdout.write(JSON.stringify({ type: "text", data: "done" }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "end", stopReason: "EndTurn" }) + "\\n");
      process.exit(0);
    `);
    __setGrokBinaryForTests(fake);

    const repoRoot = mkdtempSync(join(tmpdir(), "revu-repo-"));
    tmpDirs.push(repoRoot);
    mkdirSync(join(repoRoot, ".git")); // not required, but keeps path realistic

    const agent = grokBuildProvider({ model: "grok-4.5" });
    const result = await agent.run({
      ruleId: "logging",
      rulesFilePath: ".revu/logging.revu.md",
      rulesContent: "# logging\nFlag console.log",
      reviewTarget: {
        mode: "ref-range",
        base: "origin/main",
        baseSha: "aaa",
        head: "HEAD",
        headSha: "bbb",
        changedFiles: ["src/a.ts"],
      },
      repoRoot,
      mcp: { url: "http://127.0.0.1:5555/mcp", authToken: "secret" },
      timeoutMs: 10_000,
    });

    expect(result.ok).toBe(true);
    expect(result.diagnostics?.textChars).toBe(4);

    const capture = JSON.parse(readFileSync(capturePath, "utf8")) as {
      argv: string[];
      grokHome: string;
      cwd: string;
      configToml: string;
    };
    expect(capture.cwd).toBe(repoRoot);
    expect(capture.grokHome).toBeTruthy();
    expect(capture.argv).toContain("-p");
    expect(capture.argv).toContain("--output-format");
    expect(capture.argv).toContain("streaming-json");
    expect(capture.argv).toContain("--system-prompt-override");
    expect(capture.argv).toContain("-m");
    expect(capture.argv).toContain("grok-4.5");
    expect(capture.argv).toContain("--permission-mode");
    expect(capture.argv).toContain("dontAsk");
    expect(capture.argv).toContain("--sandbox");
    expect(capture.argv).toContain("read-only");
    expect(capture.argv).toContain("--no-subagents");
    expect(capture.argv).toContain("--disable-web-search");
    expect(capture.argv).toContain("--allow");
    expect(capture.argv.some((a) => a.includes("MCPTool(revu__*)"))).toBe(true);

    expect(capture.configToml).toContain("[mcp_servers.revu]");
    expect(capture.configToml).toContain("http://127.0.0.1:5555/mcp");
    expect(capture.configToml).toContain("Bearer secret");
    expect(capture.configToml).toContain("logging");
  });

  it("returns a timedOut result when the child is aborted by the wall-clock timer", async () => {
    const fake = makeFakeGrok(`
      setInterval(() => {}, 1000); // hang forever
    `);
    __setGrokBinaryForTests(fake);

    const repoRoot = mkdtempSync(join(tmpdir(), "revu-repo-"));
    tmpDirs.push(repoRoot);

    const agent = grokBuildProvider({});
    const result = await agent.run({
      ruleId: "hang",
      rulesFilePath: ".revu/hang.revu.md",
      rulesContent: "# hang",
      reviewTarget: {
        mode: "ref-range",
        base: "origin/main",
        baseSha: "a",
        head: "HEAD",
        headSha: "b",
        changedFiles: [],
      },
      repoRoot,
      mcp: { url: "http://127.0.0.1:1/mcp", authToken: "t" },
      timeoutMs: 200,
    });

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.errorMessage).toMatch(/timed out/i);
  });

  it("surfaces streaming error events as rule failures", async () => {
    const fake = makeFakeGrok(`
      process.stdout.write(JSON.stringify({ type: "error", message: "Incorrect API key" }) + "\\n");
      process.exit(1);
    `);
    __setGrokBinaryForTests(fake);

    const repoRoot = mkdtempSync(join(tmpdir(), "revu-repo-"));
    tmpDirs.push(repoRoot);

    const agent = grokBuildProvider({});
    const result = await agent.run({
      ruleId: "auth",
      rulesFilePath: ".revu/auth.revu.md",
      rulesContent: "# auth",
      reviewTarget: {
        mode: "ref-range",
        base: "origin/main",
        baseSha: "a",
        head: "HEAD",
        headSha: "b",
        changedFiles: [],
      },
      repoRoot,
      mcp: { url: "http://127.0.0.1:1/mcp", authToken: "t" },
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(false);
    expect(result.errorMessage).toMatch(/Incorrect API key/);
  });
});
