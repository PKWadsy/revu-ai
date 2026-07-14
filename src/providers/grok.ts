import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
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

/** Grok Build's flagship coding model — the same model that powers the CLI's
 *  interactive agent. Used when the user doesn't pin one via --model. */
export const DEFAULT_GROK_MODEL = "grok-4.5";

/** The `grok` binary name. Installed via https://x.ai/cli (to `~/.grok/bin`);
 *  we spawn by name and rely on PATH, surfacing a clear message on ENOENT. */
const GROK_BIN = "grok";

interface GrokConfig {
  model?: string;
  provider?: string;
}

/**
 * Built-in tools the reviewer must never touch. Grok Build mirrors Claude
 * Code's tool names, so these are the file-mutating ones. Removing them with
 * `--disallowed-tools` (and denying them again via `--deny`) keeps a review
 * strictly read-only. Bash stays available — revu reviewers inspect the diff
 * with their own `git diff` calls — so read-only bash discipline is enforced
 * by the shared review system prompt, exactly as it is for the opencode
 * harness (grok's headless mode has no per-call `canUseTool` gate). The run
 * executes in an ephemeral, isolated `$HOME`, so residual risk is bounded.
 */
const MUTATING_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Patch"];

/** Mutating git subcommands and shell binaries denied as defense-in-depth on
 *  top of the read-only system prompt. Expressed as Claude-Code-compatible
 *  permission rules that Grok Build accepts via `--deny`. */
const DENY_BASH_RULES = [
  "Bash(git push:*)",
  "Bash(git commit:*)",
  "Bash(git checkout:*)",
  "Bash(git reset:*)",
  "Bash(git rebase:*)",
  "Bash(git merge:*)",
  "Bash(git pull:*)",
  "Bash(git fetch:*)",
  "Bash(rm:*)",
  "Bash(mv:*)",
  "Bash(chmod:*)",
];

/**
 * Render the per-run `~/.grok/config.toml` for an isolated `$HOME`. Registers
 * the revu MCP sidecar as a remote HTTP server with the bearer token and the
 * per-rule `X-Revu-Rule-Id` header the aggregator uses to attribute findings.
 *
 * `auto_update`/`use_leader` are disabled so no background update check runs
 * and each invocation gets its own agent backend (no shared leader daemon /
 * socket collisions under parallel rule fan-out).
 */
export function renderGrokConfigToml(args: {
  mcpUrl: string;
  authToken: string;
  ruleId: string;
}): string {
  const q = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return [
    "[cli]",
    "auto_update = false",
    "use_leader = false",
    "",
    "[mcp_servers.revu]",
    `url = ${q(args.mcpUrl)}`,
    "enabled = true",
    "",
    "[mcp_servers.revu.headers]",
    `Authorization = ${q(`Bearer ${args.authToken}`)}`,
    `X-Revu-Rule-Id = ${q(args.ruleId)}`,
    "",
  ].join("\n");
}

/** Build the argv for a headless review run. Kept pure so tests can pin the
 *  flag contract without spawning a process. */
export function buildGrokReviewArgs(args: {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  repoRoot: string;
}): string[] {
  const argv = [
    "-p",
    args.userPrompt,
    "--system-prompt-override",
    args.systemPrompt,
    "-m",
    args.model,
    "--output-format",
    "streaming-json",
    "--cwd",
    args.repoRoot,
    "--always-approve",
    "--no-subagents",
    "--no-plan",
    "--no-memory",
    "--disable-web-search",
    "--disallowed-tools",
    MUTATING_TOOLS.join(","),
  ];
  for (const t of MUTATING_TOOLS) argv.push("--deny", t);
  for (const rule of DENY_BASH_RULES) argv.push("--deny", rule);
  return argv;
}

/** Build the argv for a headless scaffold (`init`) run. File writes are routed
 *  through the MCP `write_rule_file` tool, so built-in write tools stay denied. */
export function buildGrokScaffoldArgs(args: {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  repoRoot: string;
}): string[] {
  return [
    "-p",
    args.userPrompt,
    "--system-prompt-override",
    args.systemPrompt,
    "-m",
    args.model,
    "--output-format",
    "streaming-json",
    "--cwd",
    args.repoRoot,
    "--always-approve",
    "--no-subagents",
    "--no-plan",
    "--no-memory",
    "--disable-web-search",
    "--disallowed-tools",
    MUTATING_TOOLS.join(","),
  ];
}

/** Translate Grok Build's streamed tool names to the Claude-Code-shaped names
 *  the CLI progress renderer already knows, so output is uniform across
 *  harnesses. MCP tools surface as `mcp__<server>__<tool>` (Claude-compatible)
 *  but we normalise a few alternate shapes defensively. */
export function mapGrokToolName(name: string): string {
  const lower = name.toLowerCase();
  if (lower === "bash" || lower === "shell") return "Bash";
  if (lower === "read") return "Read";
  if (lower === "grep") return "Grep";
  if (lower === "glob" || lower === "list") return "Glob";
  if (lower === "write") return "Write";
  if (lower === "edit") return "Edit";
  // MCP tool names may arrive as `mcp__revu__x`, `revu__x`, `revu.x`, or `revu_x`.
  const mcp = name.match(/revu[._]{1,2}(\w+)/);
  if (mcp) return `mcp__revu__${mcp[1]}`;
  if (name.startsWith("mcp__")) return name;
  return name;
}

interface IsolatedHome {
  home: string;
  cleanup: () => void;
}

/** Create a throwaway `$HOME` seeded with a `.grok/config.toml` and (if the
 *  real home has one) the cached `auth.json`, so a user who ran `grok login`
 *  stays authenticated without leaking the shared config/leader socket. */
function createIsolatedHome(configToml: string): IsolatedHome {
  const home = mkdtempSync(join(tmpdir(), "revu-grok-"));
  const grokDir = join(home, ".grok");
  mkdirSync(grokDir, { recursive: true });
  writeFileSync(join(grokDir, "config.toml"), configToml, "utf8");
  const realHome = process.env["HOME"] ?? homedir();
  const realAuth = join(realHome, ".grok", "auth.json");
  if (existsSync(realAuth)) {
    try {
      copyFileSync(realAuth, join(grokDir, "auth.json"));
    } catch {
      /* best-effort — XAI_API_KEY is the fallback auth path */
    }
  }
  return {
    home,
    cleanup: () => {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

interface RunProcessResult {
  errorMessage?: string;
}

/**
 * Spawn `grok` with an isolated `$HOME`, stream its newline-delimited
 * `streaming-json` events, and resolve once the process exits. Findings flow
 * through the MCP sidecar (not stdout), so stdout parsing only drives the live
 * progress UI and the diagnostics counters — a best-effort concern that never
 * affects finding correctness.
 */
function runGrokProcess(opts: {
  args: string[];
  home: string;
  repoRoot: string;
  abort: AbortController;
  label: string;
  onEvent: (ev: Record<string, unknown>) => void;
}): Promise<RunProcessResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: RunProcessResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    const child = spawn(GROK_BIN, opts.args, {
      cwd: opts.repoRoot,
      env: { ...process.env, HOME: opts.home },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const onAbort = (): void => {
      child.kill("SIGTERM");
      // Escalate if it ignores SIGTERM.
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 2000).unref();
    };
    opts.abort.signal.addEventListener("abort", onAbort, { once: true });

    let streamError: string | undefined;

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line: string) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed[0] !== "{") return;
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        return;
      }
      if (ev["type"] === "error" && typeof ev["message"] === "string" && !streamError) {
        streamError = ev["message"] as string;
      }
      try {
        opts.onEvent(ev);
      } catch {
        /* progress rendering must never break the run */
      }
    });

    child.stderr.on("data", (d: Buffer) => {
      if (process.env["REVU_DEBUG"]) process.stderr.write(`[${opts.label}] ${d}`);
    });

    child.on("error", (e: NodeJS.ErrnoException) => {
      opts.abort.signal.removeEventListener("abort", onAbort);
      if (e.code === "ENOENT") {
        done({
          errorMessage:
            "grok binary not found on PATH. Install Grok Build (https://x.ai/cli) and ensure `~/.grok/bin` is on PATH before using --harness grok.",
        });
        return;
      }
      done({ errorMessage: e.message });
    });

    child.on("close", (code: number | null) => {
      opts.abort.signal.removeEventListener("abort", onAbort);
      rl.close();
      if (streamError) {
        done({ errorMessage: `grok: ${streamError}` });
        return;
      }
      if (code !== 0 && code !== null && !opts.abort.signal.aborted) {
        done({ errorMessage: `grok exited with code ${code}` });
        return;
      }
      done({});
    });
  });
}

export const grokProvider: ReviewAgentFactory = (cfg: GrokConfig) => ({
  name: "grok",
  async run(input: ReviewInput): Promise<ReviewResult> {
    const start = Date.now();
    const model = cfg.model ?? DEFAULT_GROK_MODEL;

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

    const isolated = createIsolatedHome(
      renderGrokConfigToml({ mcpUrl: input.mcp.url, authToken: input.mcp.authToken, ruleId: input.ruleId }),
    );

    const diagnostics: ReviewDiagnostics = { textChars: 0, findingToolCalls: 0 };
    const announced = new Set<string>();

    const onEvent = (ev: Record<string, unknown>): void => {
      processGrokEvent(ev, input.onActivity, announced, diagnostics);
    };

    try {
      const systemPrompt = buildSystemPrompt({
        ruleId: input.ruleId,
        rulesContent: input.rulesContent,
        reviewTarget: input.reviewTarget,
        ...(input.priorFindings ? { priorFindings: input.priorFindings } : {}),
        ...(input.priorHeadSha ? { priorHeadSha: input.priorHeadSha } : {}),
        ...(input.filePatterns ? { filePatterns: input.filePatterns } : {}),
      });
      const args = buildGrokReviewArgs({
        model,
        systemPrompt,
        userPrompt: buildUserPrompt(input.reviewTarget),
        repoRoot: input.repoRoot,
      });

      const { errorMessage } = await runGrokProcess({
        args,
        home: isolated.home,
        repoRoot: input.repoRoot,
        abort,
        label: input.ruleId,
        onEvent,
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
        return { ruleId: input.ruleId, ok: false, durationMs: Date.now() - start, errorMessage, diagnostics };
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
        errorMessage: (e as Error).message ?? String(e),
      };
    } finally {
      if (timer) clearTimeout(timer);
      isolated.cleanup();
    }
  },
});

export const grokScaffoldProvider: ScaffoldAgentFactory = (cfg: GrokConfig) => ({
  name: "grok",
  async run(input: ScaffoldInput): Promise<ScaffoldResult> {
    const start = Date.now();
    const model = cfg.model ?? DEFAULT_GROK_MODEL;

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

    const isolated = createIsolatedHome(
      renderGrokConfigToml({ mcpUrl: sidecar.url, authToken: sidecar.authToken, ruleId: "__scaffold__" }),
    );

    const announced = new Set<string>();
    const scratch: ReviewDiagnostics = { textChars: 0, findingToolCalls: 0 };
    const onEvent = (ev: Record<string, unknown>): void => {
      if (input.onActivity) processGrokEvent(ev, input.onActivity, announced, scratch);
    };

    try {
      const args = buildGrokScaffoldArgs({
        model,
        systemPrompt: buildGrokScaffoldSystemPrompt(input.force),
        userPrompt: buildInitUserPrompt({ repoRoot: input.repoRoot, force: input.force }),
        repoRoot: input.repoRoot,
      });

      const { errorMessage } = await runGrokProcess({
        args,
        home: isolated.home,
        repoRoot: input.repoRoot,
        abort,
        label: "scaffold",
        onEvent,
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
      return { ok: false, durationMs: Date.now() - start, filesWritten, errorMessage: (e as Error).message ?? String(e) };
    } finally {
      if (timer) clearTimeout(timer);
      isolated.cleanup();
      await sidecar.shutdown().catch(() => {/* best-effort */});
    }
  },
});

/** Variant of the scaffold system prompt that points the agent at the sidecar
 *  `mcp__revu__write_rule_file` tool instead of the built-in `Write` (which is
 *  denied). Mirrors the opencode harness's transformation. */
function buildGrokScaffoldSystemPrompt(force: boolean): string {
  const base = buildInitSystemPrompt({ force });
  return base
    .replace(
      /- `Write` — restricted to.*?\.\n/,
      "- `mcp__revu__write_rule_file` — the ONLY way to create rule files. Pass `path` (repo-relative, must end in `.revu.md`) and `content`. The server enforces path safety and rejects out-of-tree paths.\n",
    )
    .replace(
      /You cannot Edit existing files\..*$/m,
      "You cannot Edit existing files. You cannot run tests, builds, or arbitrary code. The built-in `write` and `edit` tools are disabled — use `mcp__revu__write_rule_file` to create rule files.",
    )
    .replace(/Write each file with `Write`/g, "Write each file with `mcp__revu__write_rule_file`");
}

/** Update diagnostics and (optionally) emit a progress activity for one
 *  streamed event. Tolerant of Grok Build's event-shape variations — findings
 *  themselves never depend on this parsing. */
function processGrokEvent(
  ev: Record<string, unknown>,
  onActivity: ((a: ReviewActivity) => void) | undefined,
  announced: Set<string>,
  diagnostics: ReviewDiagnostics,
): void {
  const type = typeof ev["type"] === "string" ? (ev["type"] as string) : "";

  if (type.includes("tool")) {
    const rawName = firstString(ev["name"], ev["tool"], ev["toolName"], ev["tool_name"]);
    if (!rawName) return;
    const callId = firstString(ev["id"], ev["callId"], ev["call_id"], ev["toolCallId"]) ?? `${rawName}:${announced.size}`;
    if (announced.has(callId)) return;
    announced.add(callId);
    const name = mapGrokToolName(rawName);
    if (name.includes("report_finding")) diagnostics.findingToolCalls += 1;
    if (onActivity) {
      const rawInput = ev["input"] ?? ev["arguments"] ?? ev["args"] ?? ev["parameters"];
      onActivity({ kind: "tool", name, detail: summarizeInput(name, rawInput) });
    }
    return;
  }

  if (type === "text" || type === "assistant" || type === "message") {
    const text = firstString(ev["text"], ev["content"], ev["delta"], (ev["message"] as { text?: unknown } | undefined)?.text);
    if (!text) return;
    const trimmed = text.trim();
    diagnostics.textChars += trimmed.length;
    if (onActivity && trimmed) onActivity({ kind: "text", detail: truncate(trimmed.replace(/\s+/g, " "), 120) });
  }
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) if (typeof v === "string" && v.length > 0) return v;
  return undefined;
}

function summarizeInput(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  if ((name === "Bash") && typeof i["command"] === "string") {
    return truncate((i["command"] as string).replace(/\s+/g, " "), 90);
  }
  if (name === "Read" && typeof i["file_path"] === "string") return i["file_path"] as string;
  if (name === "Read" && typeof i["filePath"] === "string") return i["filePath"] as string;
  if (name === "Grep" && typeof i["pattern"] === "string") {
    const path = typeof i["path"] === "string" ? ` in ${i["path"]}` : "";
    return `${i["pattern"]}${path}`;
  }
  if (name === "Glob" && typeof i["pattern"] === "string") return i["pattern"] as string;
  if (name.startsWith("mcp__") && typeof i["severity"] === "string" && typeof i["path"] === "string") {
    const line = typeof i["line"] === "number" ? `:${i["line"]}` : "";
    return `${i["severity"]} ${i["path"]}${line}`;
  }
  if (name.startsWith("mcp__") && typeof i["path"] === "string") return i["path"] as string;
  try {
    return truncate(JSON.stringify(i), 90);
  } catch {
    return "";
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
