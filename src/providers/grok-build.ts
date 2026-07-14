import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { createInterface } from "node:readline";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSystemPrompt } from "../prompts/review-system.js";
import { buildUserPrompt } from "../prompts/review-user.js";
import { buildInitSystemPrompt } from "../prompts/init-system.js";
import { buildInitUserPrompt } from "../prompts/init-user.js";
import { startSidecar } from "../mcp/server.js";
import type {
  ReviewActivity,
  ReviewAgentFactory,
  ReviewDiagnostics,
  ReviewInput,
  ReviewResult,
  ScaffoldAgentFactory,
  ScaffoldInput,
  ScaffoldResult,
} from "./types.js";

/**
 * Grok Build's recommended coding/agent model. As of Grok 4.5, this alias is
 * the CLI default and resolves to the same model family as the API id
 * `grok-4.5` (also aliased as `grok-build-latest`).
 */
export const DEFAULT_GROK_BUILD_MODEL = "grok-build";

interface GrokBuildConfig {
  model?: string;
  provider?: string;
}

/** Test seam — override the binary path without mutating PATH. */
let grokBinaryOverride: string | undefined;

export function __setGrokBinaryForTests(path: string | undefined): void {
  grokBinaryOverride = path;
}

export function resolveGrokModel(cfg: GrokBuildConfig): string {
  const m = cfg.model?.trim();
  return m && m.length > 0 ? m : DEFAULT_GROK_BUILD_MODEL;
}

/**
 * Grok Build namespaces MCP tools as `<server>__<tool>` (see docs.x.ai/build
 * MCP Servers). Our shared system prompts use Claude Code's `mcp__revu__*`
 * form — rewrite so the model looks for tools that actually exist.
 */
export function rewriteMcpToolNamesForGrok(prompt: string): string {
  return prompt.replaceAll("mcp__revu__", "revu__");
}

export function buildGrokHomeConfig(opts: {
  mcpUrl: string;
  authToken: string;
  ruleId: string;
  model: string;
}): string {
  const lines: string[] = [
    "[cli]",
    "auto_update = false",
    "",
    "[models]",
    `default = ${tomlString(opts.model)}`,
    "",
  ];

  // Built-in aliases (`grok-build`, `grok-build-latest`) are known to the CLI.
  // Raw API ids like `grok-4.5` need an explicit model entry so catalog lag /
  // offline resolution can't reject them with "unknown model id".
  if (needsExplicitModelEntry(opts.model)) {
    lines.push(
      `[model.${tomlString(opts.model)}]`,
      `model = ${tomlString(opts.model)}`,
      `base_url = "https://api.x.ai/v1"`,
      `name = ${tomlString(opts.model)}`,
      `env_key = "XAI_API_KEY"`,
      `api_backend = "responses"`,
      "",
    );
  }

  // Don't pull in host Claude/Cursor MCP servers from the developer's machine
  // — each rule run should only see the revu sidecar we configure below.
  lines.push(
    "[compat.claude]",
    "mcps = false",
    "",
    "[compat.cursor]",
    "mcps = false",
    "",
    "[mcp_servers.revu]",
    `url = ${tomlString(opts.mcpUrl)}`,
    "enabled = true",
    "headers = { " +
      `Authorization = ${tomlString(`Bearer ${opts.authToken}`)}, ` +
      `"X-Revu-Rule-Id" = ${tomlString(opts.ruleId)}` +
      " }",
    "",
  );

  return lines.join("\n");
}

function needsExplicitModelEntry(model: string): boolean {
  // Known Grok Build aliases that ship with the CLI catalog.
  if (model === "grok-build" || model === "grok-build-latest") return false;
  return true;
}

function tomlString(value: string): string {
  // TOML basic strings: escape backslash and double-quote.
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function accumulateGrokStreamEvent(
  event: Record<string, unknown>,
  diagnostics: ReviewDiagnostics,
  onActivity?: (activity: ReviewActivity) => void,
): string | undefined {
  const type = event["type"];
  if (type === "text") {
    const data = typeof event["data"] === "string" ? event["data"] : "";
    const trimmed = data.trim();
    if (trimmed) {
      diagnostics.textChars += trimmed.length;
      onActivity?.({ kind: "text", detail: truncate(trimmed.replace(/\s+/g, " "), 120) });
    }
    return undefined;
  }
  if (type === "error") {
    const message = typeof event["message"] === "string" ? event["message"] : "unknown error";
    return message;
  }
  // thought / end / max_turns_reached / auto_compact_* — ignore for diagnostics.
  return undefined;
}

export function formatGrokBinaryError(err: unknown): string {
  const e = err as NodeJS.ErrnoException;
  if (e?.code === "ENOENT" || /ENOENT|spawn .*grok/i.test(e?.message ?? "")) {
    return (
      "grok binary not found on PATH. Install Grok Build " +
      "(https://x.ai/cli or `npm i -g @xai-official/grok`) before using --harness grok-build."
    );
  }
  return e?.message ?? String(err);
}

export const grokBuildProvider: ReviewAgentFactory = (cfg: GrokBuildConfig) => ({
  name: "grok-build",
  async run(input: ReviewInput): Promise<ReviewResult> {
    const start = Date.now();
    const model = resolveGrokModel(cfg);

    const abort = new AbortController();
    if (input.signal) {
      input.signal.addEventListener("abort", () => abort.abort(), { once: true });
    }

    let timedOut = false;
    const timer = input.timeoutMs && input.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          abort.abort();
        }, input.timeoutMs)
      : undefined;

    const grokHome = mkdtempSync(join(tmpdir(), "revu-grok-"));
    try {
      writeFileSync(
        join(grokHome, "config.toml"),
        buildGrokHomeConfig({
          mcpUrl: input.mcp.url,
          authToken: input.mcp.authToken,
          ruleId: input.ruleId,
          model,
        }),
      );

      const systemPrompt = rewriteMcpToolNamesForGrok(
        buildSystemPrompt({
          ruleId: input.ruleId,
          rulesContent: input.rulesContent,
          reviewTarget: input.reviewTarget,
          ...(input.priorFindings ? { priorFindings: input.priorFindings } : {}),
          ...(input.priorHeadSha ? { priorHeadSha: input.priorHeadSha } : {}),
          ...(input.filePatterns ? { filePatterns: input.filePatterns } : {}),
        }),
      );
      const userPrompt = buildUserPrompt(input.reviewTarget);

      const diagnostics: ReviewDiagnostics = { textChars: 0, findingToolCalls: 0 };
      const argv = buildReviewArgv({
        model,
        systemPrompt,
        userPrompt,
        cwd: input.repoRoot,
      });

      const { exitCode, errorMessage } = await runGrokProcess({
        argv,
        cwd: input.repoRoot,
        grokHome,
        signal: abort.signal,
        diagnostics,
        onActivity: input.onActivity,
      });

      if (timedOut) {
        return {
          ruleId: input.ruleId,
          ok: false,
          durationMs: Date.now() - start,
          errorMessage: `timed out after ${input.timeoutMs}ms`,
          timedOut: true,
        };
      }
      if (errorMessage) {
        return {
          ruleId: input.ruleId,
          ok: false,
          durationMs: Date.now() - start,
          errorMessage,
          diagnostics,
        };
      }
      if (exitCode !== 0) {
        return {
          ruleId: input.ruleId,
          ok: false,
          durationMs: Date.now() - start,
          errorMessage: `grok exited with code ${exitCode}`,
          diagnostics,
        };
      }
      return { ruleId: input.ruleId, ok: true, durationMs: Date.now() - start, diagnostics };
    } catch (e) {
      if (timedOut) {
        return {
          ruleId: input.ruleId,
          ok: false,
          durationMs: Date.now() - start,
          errorMessage: `timed out after ${input.timeoutMs}ms`,
          timedOut: true,
        };
      }
      return {
        ruleId: input.ruleId,
        ok: false,
        durationMs: Date.now() - start,
        errorMessage: formatGrokBinaryError(e),
      };
    } finally {
      if (timer) clearTimeout(timer);
      try {
        rmSync(grokHome, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  },
});

export const grokBuildScaffoldProvider: ScaffoldAgentFactory = (cfg: GrokBuildConfig) => ({
  name: "grok-build",
  async run(input: ScaffoldInput): Promise<ScaffoldResult> {
    const start = Date.now();
    const model = resolveGrokModel(cfg);

    const abort = new AbortController();
    if (input.signal) {
      input.signal.addEventListener("abort", () => abort.abort(), { once: true });
    }

    let timedOut = false;
    const timer = input.timeoutMs && input.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          abort.abort();
        }, input.timeoutMs)
      : undefined;

    const filesWritten: string[] = [];
    const sidecar = await startSidecar({
      repoRoot: input.repoRoot,
      scaffold: {
        onFileWritten: (rel) => {
          filesWritten.push(rel);
          input.onFileWritten?.(rel);
        },
      },
    });

    const grokHome = mkdtempSync(join(tmpdir(), "revu-grok-scaffold-"));
    try {
      writeFileSync(
        join(grokHome, "config.toml"),
        buildGrokHomeConfig({
          mcpUrl: sidecar.url,
          authToken: sidecar.authToken,
          ruleId: "__scaffold__",
          model,
        }),
      );

      const systemPrompt = rewriteMcpToolNamesForGrok(buildGrokScaffoldSystemPrompt(input.force));
      const userPrompt = buildInitUserPrompt({ repoRoot: input.repoRoot, force: input.force });

      const diagnostics: ReviewDiagnostics = { textChars: 0, findingToolCalls: 0 };
      const argv = buildScaffoldArgv({
        model,
        systemPrompt,
        userPrompt,
        cwd: input.repoRoot,
      });

      const { exitCode, errorMessage } = await runGrokProcess({
        argv,
        cwd: input.repoRoot,
        grokHome,
        signal: abort.signal,
        diagnostics,
        onActivity: input.onActivity,
      });

      if (timedOut) {
        return {
          ok: false,
          durationMs: Date.now() - start,
          filesWritten,
          errorMessage: `timed out after ${input.timeoutMs}ms`,
          timedOut: true,
        };
      }
      if (errorMessage) {
        return { ok: false, durationMs: Date.now() - start, filesWritten, errorMessage };
      }
      if (exitCode !== 0) {
        return {
          ok: false,
          durationMs: Date.now() - start,
          filesWritten,
          errorMessage: `grok exited with code ${exitCode}`,
        };
      }
      return { ok: true, durationMs: Date.now() - start, filesWritten };
    } catch (e) {
      if (timedOut) {
        return {
          ok: false,
          durationMs: Date.now() - start,
          filesWritten,
          errorMessage: `timed out after ${input.timeoutMs}ms`,
          timedOut: true,
        };
      }
      return {
        ok: false,
        durationMs: Date.now() - start,
        filesWritten,
        errorMessage: formatGrokBinaryError(e),
      };
    } finally {
      if (timer) clearTimeout(timer);
      try {
        rmSync(grokHome, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      await sidecar.shutdown().catch(() => {/* best-effort */});
    }
  },
});

function buildReviewArgv(opts: {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  cwd: string;
}): string[] {
  return [
    "-p", opts.userPrompt,
    "-m", opts.model,
    "--cwd", opts.cwd,
    "--output-format", "streaming-json",
    "--system-prompt-override", opts.systemPrompt,
    "--permission-mode", "dontAsk",
    "--sandbox", "read-only",
    "--no-subagents",
    "--disable-web-search",
    "--disallowed-tools", "Edit,Write,MultiEdit,NotebookEdit,WebFetch,Task",
    // Under dontAsk, MCP tools need an explicit allow (read-only builtins are
    // always-safe and auto-approved; MCP is not).
    "--allow", "MCPTool(revu__*)",
    "--allow", "Read",
    "--allow", "Grep",
    "--allow", "Bash(git *)",
    "--allow", "Bash(cat *)",
    "--allow", "Bash(head *)",
    "--allow", "Bash(tail *)",
    "--allow", "Bash(ls *)",
    "--allow", "Bash(rg *)",
    "--allow", "Bash(grep *)",
    "--allow", "Bash(find *)",
    "--allow", "Bash(wc *)",
    "--allow", "Bash(pwd)",
    "--deny", "Edit",
    "--deny", "WebFetch",
  ];
}

function buildScaffoldArgv(opts: {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  cwd: string;
}): string[] {
  return [
    "-p", opts.userPrompt,
    "-m", opts.model,
    "--cwd", opts.cwd,
    "--output-format", "streaming-json",
    "--system-prompt-override", opts.systemPrompt,
    "--permission-mode", "dontAsk",
    // Scaffold needs to write rule files via the MCP sidecar — read-only
    // sandbox would block the sidecar's own fs writes on some platforms, so
    // keep the process sandbox off and deny Edit/Write at the permission layer.
    "--no-subagents",
    "--disable-web-search",
    "--disallowed-tools", "Edit,Write,MultiEdit,NotebookEdit,WebFetch,Task",
    "--allow", "MCPTool(revu__*)",
    "--allow", "Read",
    "--allow", "Grep",
    "--allow", "Bash(git *)",
    "--allow", "Bash(cat *)",
    "--allow", "Bash(head *)",
    "--allow", "Bash(tail *)",
    "--allow", "Bash(ls *)",
    "--allow", "Bash(rg *)",
    "--allow", "Bash(grep *)",
    "--allow", "Bash(find *)",
    "--allow", "Bash(wc *)",
    "--allow", "Bash(pwd)",
    "--deny", "Edit",
    "--deny", "Write",
    "--deny", "WebFetch",
  ];
}

/** Variant of the scaffold system prompt that routes writes through the
 *  sidecar MCP tool (same pattern as the opencode harness). */
function buildGrokScaffoldSystemPrompt(force: boolean): string {
  const base = buildInitSystemPrompt({ force });
  return base
    .replace(
      /- `Write` — restricted to.*?\.\n/,
      "- `revu__write_rule_file` — the ONLY way to create rule files. Pass `path` (repo-relative, must end in `.revu.md`) and `content`. The server enforces path safety and rejects out-of-tree paths.\n",
    )
    .replace(
      /You cannot Edit existing files\..*$/m,
      "You cannot Edit existing files. You cannot run tests, builds, or arbitrary code. The built-in `write` and `edit` tools are disabled — use `revu__write_rule_file` to create rule files.",
    )
    .replace(/Write each file with `Write`/g, "Write each file with `revu__write_rule_file`");
}

async function runGrokProcess(opts: {
  argv: string[];
  cwd: string;
  grokHome: string;
  signal: AbortSignal;
  diagnostics: ReviewDiagnostics;
  onActivity?: (activity: ReviewActivity) => void;
}): Promise<{ exitCode: number; errorMessage?: string }> {
  const bin = grokBinaryOverride ?? "grok";
  let child: ChildProcessByStdio<null, Readable, Readable>;
  try {
    child = spawn(bin, opts.argv, {
      cwd: opts.cwd,
      env: {
        ...process.env,
        GROK_HOME: opts.grokHome,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    throw e;
  }

  let streamError: string | undefined;
  let stderrBuf = "";

  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }
    const err = accumulateGrokStreamEvent(event, opts.diagnostics, opts.onActivity);
    if (err) streamError = err;
  });

  child.stderr.on("data", (chunk: Buffer | string) => {
    const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    stderrBuf += s;
    if (process.env.REVU_DEBUG) {
      process.stderr.write(`[grok-build] ${s}`);
    }
  });

  const onAbort = (): void => {
    try {
      child.kill("SIGTERM");
      // Escalation if the child ignores SIGTERM (long-running inference).
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      }, 2_000).unref();
    } catch {
      /* already dead */
    }
  };
  if (opts.signal.aborted) onAbort();
  else opts.signal.addEventListener("abort", onAbort, { once: true });

  const exitCode: number = await new Promise((resolve, reject) => {
    child.on("error", (err) => {
      reject(err);
    });
    child.on("close", (code) => {
      resolve(code ?? 1);
    });
  });

  rl.close();
  opts.signal.removeEventListener("abort", onAbort);

  if (streamError) {
    return { exitCode, errorMessage: streamError };
  }
  if (exitCode !== 0 && stderrBuf.trim()) {
    // Prefer a concise stderr snippet when the stream didn't emit an error event.
    return { exitCode, errorMessage: truncate(stderrBuf.trim().replace(/\s+/g, " "), 400) };
  }
  return { exitCode };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
