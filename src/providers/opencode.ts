import { createServer as createNetServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, setGlobalDispatcher } from "undici";
import { createOpencode } from "@opencode-ai/sdk";
import type { Config, Event } from "@opencode-ai/sdk";

/**
 * Node's built-in `fetch` (undici) has a default `headersTimeout` of 5 minutes:
 * if the response headers don't arrive in time, the request dies with a
 * generic "fetch failed". The opencode SDK's `session.prompt(...)` is a
 * blocking POST — opencode doesn't return the HTTP response until the agent's
 * loop is fully done. A long Grok inference (>5 min) hits this ceiling
 * silently; in revu-ai's logs it surfaces as `errorMessage: "fetch failed"`
 * with `durationMs: ~305000`, NOT a clean revu timeout.
 *
 * Disable both undici timeouts (headers + body) for the whole process so
 * revu's own per-rule `--timeout-ms` is the only ceiling. Affects every
 * `globalThis.fetch` call in this Node process — fine for a CLI tool;
 * something to revisit if revu-ai is ever embedded as a library.
 *
 * Tracked upstream as opencode-ai#15555.
 */
let dispatcherExtended = false;
function ensureLongRunningDispatcher(): void {
  if (dispatcherExtended) return;
  dispatcherExtended = true;
  setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));
}
import { buildSystemPrompt } from "../prompts/review-system.js";
import { buildUserPrompt } from "../prompts/review-user.js";
import { buildInitSystemPrompt } from "../prompts/init-system.js";
import { buildInitUserPrompt } from "../prompts/init-user.js";
import { startSidecar } from "../mcp/server.js";
import type {
  ReviewActivity,
  ReviewAgentFactory,
  ReviewInput,
  ReviewResult,
  ScaffoldAgentFactory,
  ScaffoldInput,
  ScaffoldResult,
} from "./types.js";

/** opencode wants the model split as `{ providerID, modelID }`. revu's CLI
 *  already takes them separately as --provider and --model. */
interface OpencodeConfig {
  provider?: string;
  model?: string;
}

const REVIEW_TOOL_OVERRIDES: Record<string, boolean> = {
  write: false,
  edit: false,
  multiedit: false,
  patch: false,
  todowrite: false,
  webfetch: false,
  // Subagents (`task`) do their work in a separate opencode session whose
  // events get muddled into the parent's stream — and they cost extra
  // tokens for no review benefit at the rule's scope. The system prompt
  // tells the model not to use them; this is the enforcement.
  task: false,
};

const SCAFFOLD_TOOL_OVERRIDES: Record<string, boolean> = {
  write: false,
  edit: false,
  multiedit: false,
  patch: false,
  webfetch: false,
};

/**
 * Bash allowlist for the opencode harness.
 *
 * **Safety caveat (vs. the claude-code harness):** opencode's permission system
 * matches bash commands against simple glob patterns where `*` matches *any*
 * character — including shell metacharacters like `>`, `;`, `&&`, and backticks.
 * That makes this allowlist a **weaker boundary** than the claude-code provider's
 * `isReadOnlyShellCommand` (in `./claude-code.ts`), which performs token-aware
 * parsing and rejects redirects, chaining, command substitution, and unsafe git
 * subcommands.
 *
 * Concretely: `"cat *"` here will permit `cat foo > /tmp/x` if the model issues
 * the redirect, because opencode lacks a per-call gate equivalent to the Agent
 * SDK's `canUseTool`. The residual defenses are:
 *
 *   1. The reviewer system prompt explicitly tells the agent to use only
 *      read-only commands (no file edits).
 *   2. `permission.edit: "deny"` blocks opencode's built-in edit tools.
 *   3. The trailing `"*": "deny"` catchall denies anything not on this list,
 *      including obvious mutators (`rm`, `mv`, `chmod`, etc.).
 *
 * Patterns are kept narrow on purpose — exact-match where possible, prefix +
 * required space (`"cmd *"`) elsewhere — to minimise glob surface. See
 * `tests/opencode-bash.test.ts` for the cross-validation test asserting that
 * every command the patterns are meant to allow is *also* accepted by
 * `isReadOnlyShellCommand`, plus a battery of adversarial inputs that the
 * stricter validator rejects (the contract the agent is expected to respect).
 */
const READ_ONLY_BASH: Record<string, "allow" | "deny"> = {
  // git read-only subcommands — wildcard for args, but `*: deny` blocks unrelated subs.
  "git diff": "allow",
  "git diff *": "allow",
  "git log": "allow",
  "git log *": "allow",
  "git show *": "allow",
  "git status": "allow",
  "git status *": "allow",
  "git ls-files": "allow",
  "git ls-files *": "allow",
  "git rev-parse *": "allow",
  "git blame *": "allow",
  // file inspection
  "cat *": "allow",
  "head *": "allow",
  "tail *": "allow",
  "ls": "allow",
  "ls *": "allow",
  "wc *": "allow",
  "find *": "allow",
  "rg": "allow",
  "rg *": "allow",
  "grep *": "allow",
  "echo *": "allow",
  "pwd": "allow",
  "stat *": "allow",
  "file *": "allow",
  "basename *": "allow",
  "dirname *": "allow",
  // catchall — denies anything not explicitly listed above.
  "*": "deny",
};

/** Test-only export so `tests/opencode-bash.test.ts` can cross-validate every
 *  intended-allow pattern against the stricter `isReadOnlyShellCommand`. */
export const __READ_ONLY_BASH_FOR_TESTS = READ_ONLY_BASH;

export const opencodeProvider: ReviewAgentFactory = (cfg: OpencodeConfig) => ({
  name: "opencode",
  async run(input: ReviewInput): Promise<ReviewResult> {
    const start = Date.now();
    ensureLongRunningDispatcher();
    const { providerID, modelID } = parseModel(cfg);

    const abort = new AbortController();
    if (input.signal) {
      input.signal.addEventListener("abort", () => abort.abort(), { once: true });
    }

    let timedOut = false;
    let stuck = false;
    const timer = input.timeoutMs && input.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          abort.abort();
        }, input.timeoutMs)
      : undefined;

    // Stuck detector: if no activity events arrive for 90 seconds, treat
    // the agent as stuck and abort. opencode children can die silently —
    // and with undici's per-fetch timeouts disabled, a half-open socket
    // would otherwise wait until the wall-clock timeout. Reset on every
    // event the SSE stream surfaces; fire when the gap grows too large.
    const STUCK_TIMEOUT_MS = 90_000;
    let stuckTimer: NodeJS.Timeout | undefined;
    const armStuckTimer = (): void => {
      if (stuckTimer) clearTimeout(stuckTimer);
      stuckTimer = setTimeout(() => {
        stuck = true;
        abort.abort();
      }, STUCK_TIMEOUT_MS);
    };
    armStuckTimer();

    const port = await getFreePort();
    const config: Config = {
      mcp: {
        revu: {
          type: "remote",
          url: input.mcp.url,
          headers: {
            Authorization: `Bearer ${input.mcp.authToken}`,
            "X-Revu-Rule-Id": input.ruleId,
          },
          enabled: true,
        },
      },
      // Auto-register the requested model under the provider so opencode's
      // catalog lag doesn't bite. opencode's built-in xai/google/anthropic
      // providers handle auth + base URL via their own env vars; this just
      // tells opencode "yes, this model id is valid", letting users pin to
      // models the baked-in models.dev cache may not list yet (e.g.,
      // `grok-4-1-fast-reasoning` at the time of writing).
      //
      // `options.timeout` extends opencode's per-LLM-call HTTP timeout to
      // match the user's per-rule budget. opencode defaults to 5 min, which
      // a slow inference call can blow through; the failure surfaces as
      // `errorMessage: "fetch failed"` and the rule errors. Aligning both
      // timeouts means revu's `--timeout-ms` is the single boundary.
      provider: providerConfig(providerID, modelID, input.timeoutMs),
      permission: {
        edit: "deny",
        bash: READ_ONLY_BASH,
        webfetch: "deny",
      },
    };

    let opencode: Awaited<ReturnType<typeof createOpencode>> | undefined;
    const isolated = startIsolatedOpencode({
      port,
      signal: abort.signal,
      timeout: 30_000,
      config,
    });
    try {
      opencode = await isolated.opencode;
      const { client, server } = opencode;
      void server;

      const session = await client.session.create({ body: { title: `revu-${input.ruleId}` } });
      const sessionId = session.data?.id;
      if (!sessionId) {
        return errorResult(input.ruleId, start, "opencode: failed to create session");
      }

      const eventLoop = startEventLoop(client, sessionId, input, abort.signal, armStuckTimer);

      const promptResp = await client.session.prompt({
        path: { id: sessionId },
        body: {
          model: { providerID, modelID },
          system: buildSystemPrompt({
            ruleId: input.ruleId,
            rulesContent: input.rulesContent,
            reviewTarget: input.reviewTarget,
            ...(input.priorFindings ? { priorFindings: input.priorFindings } : {}),
            ...(input.priorHeadSha ? { priorHeadSha: input.priorHeadSha } : {}),
          }),
          tools: REVIEW_TOOL_OVERRIDES,
          parts: [{ type: "text", text: buildUserPrompt(input.reviewTarget) }],
        },
        // Honour the abort signal at the HTTP layer too — without this, a
        // timeout fires `abort.abort()`, kills the opencode child process,
        // but the in-flight fetch keeps waiting for a response that never
        // comes.
        signal: abort.signal,
      });

      eventLoop.stop();

      if (timedOut) {
        return timeoutResult(input.ruleId, start, input.timeoutMs);
      }
      // hey-api wraps non-2xx in `error`; 2xx populates `data`. opencode can
      // also return a 2xx with an unexpected shape (data without info) when
      // the server crashes mid-prompt — guard every hop instead of just the
      // first.
      if (promptResp.error) {
        return errorResult(input.ruleId, start, formatOpencodeError(promptResp.error));
      }
      const info = promptResp.data?.info;
      if (!info) {
        return errorResult(
          input.ruleId,
          start,
          "opencode returned no message info — server may have errored mid-prompt",
        );
      }
      if (info.error) {
        return errorResult(input.ruleId, start, formatOpencodeError(info.error));
      }
      void server;
      return { ruleId: input.ruleId, ok: true, durationMs: Date.now() - start };
    } catch (e) {
      if (timedOut) return timeoutResult(input.ruleId, start, input.timeoutMs);
      if (stuck) return errorResult(input.ruleId, start, `stuck — no activity for ${STUCK_TIMEOUT_MS / 1000}s`);
      if (abort.signal.aborted) {
        return errorResult(input.ruleId, start, "opencode run aborted");
      }
      return errorResult(input.ruleId, start, formatThrown(e));
    } finally {
      if (timer) clearTimeout(timer);
      if (stuckTimer) clearTimeout(stuckTimer);
      try { opencode?.server.close(); } catch { /* shutdown best-effort */ }
      isolated.cleanup();
    }
  },
});

export const opencodeScaffoldProvider: ScaffoldAgentFactory = (cfg: OpencodeConfig) => ({
  name: "opencode",
  async run(input: ScaffoldInput): Promise<ScaffoldResult> {
    const start = Date.now();
    ensureLongRunningDispatcher();
    const { providerID, modelID } = parseModel(cfg);

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

    const port = await getFreePort();
    const config: Config = {
      mcp: {
        revu: {
          type: "remote",
          url: sidecar.url,
          headers: {
            Authorization: `Bearer ${sidecar.authToken}`,
            "X-Revu-Rule-Id": "__scaffold__",
          },
          enabled: true,
        },
      },
      // See review path comment — auto-register the requested model so
      // opencode's catalog lag doesn't reject newly-released model ids,
      // and align the per-LLM-call HTTP timeout with the per-rule budget.
      provider: providerConfig(providerID, modelID, input.timeoutMs),
      permission: {
        edit: "deny",
        bash: READ_ONLY_BASH,
        webfetch: "deny",
      },
    };

    let opencode: Awaited<ReturnType<typeof createOpencode>> | undefined;
    const isolated = startIsolatedOpencode({
      port,
      signal: abort.signal,
      timeout: 30_000,
      config,
    });
    try {
      opencode = await isolated.opencode;
      const client = opencode.client;

      const session = await client.session.create({ body: { title: "revu-scaffold" } });
      const sessionId = session.data?.id;
      if (!sessionId) {
        return scaffoldError(start, filesWritten, "opencode: failed to create session");
      }

      const eventLoop = startScaffoldEventLoop(client, sessionId, input, abort.signal);

      const promptResp = await client.session.prompt({
        path: { id: sessionId },
        body: {
          model: { providerID, modelID },
          system: buildOpencodeScaffoldSystemPrompt(input.force),
          tools: SCAFFOLD_TOOL_OVERRIDES,
          parts: [{ type: "text", text: buildInitUserPrompt({ repoRoot: input.repoRoot, force: input.force }) }],
        },
        signal: abort.signal,
      });

      eventLoop.stop();

      if (timedOut) {
        return scaffoldTimeoutResult(start, filesWritten, input.timeoutMs);
      }
      // Same defensive shape as the review path — see opencodeProvider.run.
      if (promptResp.error) {
        return scaffoldError(start, filesWritten, formatOpencodeError(promptResp.error));
      }
      const info = promptResp.data?.info;
      if (!info) {
        return scaffoldError(
          start,
          filesWritten,
          "opencode returned no message info — server may have errored mid-prompt",
        );
      }
      if (info.error) {
        return scaffoldError(start, filesWritten, formatOpencodeError(info.error));
      }
      return { ok: true, durationMs: Date.now() - start, filesWritten };
    } catch (e) {
      if (timedOut) return scaffoldTimeoutResult(start, filesWritten, input.timeoutMs);
      if (abort.signal.aborted) {
        return scaffoldError(start, filesWritten, "opencode scaffold aborted");
      }
      return scaffoldError(start, filesWritten, formatThrown(e));
    } finally {
      if (timer) clearTimeout(timer);
      try { opencode?.server.close(); } catch { /* shutdown best-effort */ }
      isolated.cleanup();
      await sidecar.shutdown().catch(() => {/* shutdown best-effort */});
    }
  },
});

/**
 * Spawn an opencode server with an isolated `XDG_DATA_HOME` so each
 * concurrent invocation gets its own sqlite database. Without this, parallel
 * fan-out collides on `~/.local/share/opencode/opencode.db` — multiple
 * processes try to set `PRAGMA journal_mode = WAL` against the same file at
 * startup, the OS lock loses one, and the server exits 1.
 *
 * The trick that makes this safe under `Promise.all`: `createOpencode`
 * captures `process.env` synchronously inside its body before the first
 * `await` (it forwards env to a `cross-spawn`-launched child process). So if
 * we set `XDG_DATA_HOME`, call `createOpencode` (kicking off the synchronous
 * launch), and restore `XDG_DATA_HOME` — all in one synchronous block — no
 * other coroutine can interleave between mutation and capture, even though
 * other rules' `run()` calls are also racing through the same code path.
 */
function startIsolatedOpencode(options: {
  port: number;
  signal: AbortSignal;
  timeout: number;
  config: Config;
}): { opencode: ReturnType<typeof createOpencode>; cleanup: () => void } {
  const dataDir = mkdtempSync(join(tmpdir(), "revu-opencode-"));
  const previousXDG = process.env["XDG_DATA_HOME"];
  process.env["XDG_DATA_HOME"] = dataDir;
  let promise: ReturnType<typeof createOpencode>;
  try {
    // SDK runs body synchronously up to its first `await`, capturing
    // `process.env` for the spawned child along the way.
    promise = createOpencode(options);
  } finally {
    if (previousXDG === undefined) delete process.env["XDG_DATA_HOME"];
    else process.env["XDG_DATA_HOME"] = previousXDG;
  }
  return {
    opencode: promise,
    cleanup: () => {
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

function parseModel(cfg: OpencodeConfig): { providerID: string; modelID: string } {
  const provider = cfg.provider;
  const model = cfg.model;
  if (!provider || !model) {
    throw new Error(
      "opencode harness requires --provider and --model. Examples: --provider xai --model grok-4-1-fast-reasoning, --provider google --model gemini-2.5-pro, --provider anthropic --model claude-sonnet-4-6.",
    );
  }
  return { providerID: provider, modelID: model };
}

/** Build the inline `provider` block for opencode's Config: registers the
 *  exact model id under the chosen provider so opencode's catalog lag doesn't
 *  reject brand-new model ids. We also keep `options.timeout` so opencode's
 *  internal AI-SDK call timeout matches our per-rule budget — this is a
 *  belt-and-braces guard alongside the global undici dispatcher above. */
function providerConfig(
  providerID: string,
  modelID: string,
  timeoutMs: number | undefined,
): NonNullable<Config["provider"]> {
  return {
    [providerID]: {
      models: { [modelID]: {} },
      ...(timeoutMs && timeoutMs > 0 ? { options: { timeout: timeoutMs } } : {}),
    },
  };
}

interface EventLoopHandle { stop: () => void }

function startEventLoop(
  client: Awaited<ReturnType<typeof createOpencode>>["client"],
  sessionId: string,
  input: ReviewInput,
  signal: AbortSignal,
  onAnyEvent?: () => void,
): EventLoopHandle {
  const onActivity = input.onActivity;
  if (!onActivity && !onAnyEvent) return { stop: () => {} };
  let stopped = false;

  // opencode emits `message.part.updated` for every chunk of a tool's input
  // as it streams in (e.g. you'll see Glob({}) → Glob(**/*.[jt]s) for the
  // same callID). Track which callIDs we've already announced to keep the
  // progress UI clean — emit on the first sighting that has a non-empty
  // input, ignore later updates for the same callID.
  const announcedTools = new Set<string>();

  void (async () => {
    try {
      const sub = await client.event.subscribe({ signal });
      for await (const ev of sub.stream as AsyncIterable<Event>) {
        if (stopped) break;
        onAnyEvent?.();
        if (onActivity) emitActivityFromEvent(ev, sessionId, onActivity, announcedTools);
      }
    } catch {
      /* event stream errors are non-fatal — they're cosmetic progress */
    }
  })();

  return {
    stop: () => {
      stopped = true;
    },
  };
}

function startScaffoldEventLoop(
  client: Awaited<ReturnType<typeof createOpencode>>["client"],
  sessionId: string,
  input: ScaffoldInput,
  signal: AbortSignal,
): EventLoopHandle {
  if (!input.onActivity) return { stop: () => {} };
  const onActivity = input.onActivity;
  let stopped = false;
  const announcedTools = new Set<string>();

  void (async () => {
    try {
      const sub = await client.event.subscribe({ signal });
      for await (const ev of sub.stream as AsyncIterable<Event>) {
        if (stopped) break;
        emitActivityFromEvent(ev, sessionId, onActivity, announcedTools);
      }
    } catch {
      /* same robustness as review path */
    }
  })();

  return {
    stop: () => {
      stopped = true;
    },
  };
}

function emitActivityFromEvent(
  ev: Event,
  sessionId: string,
  onActivity: (a: ReviewActivity) => void,
  announcedTools: Set<string>,
): void {
  if (ev.type !== "message.part.updated") return;
  const part = ev.properties.part;
  // Each opencode server is per-rule-isolated (own port, own XDG_DATA_HOME),
  // so every event on this stream — main session OR any `task(...)` subagent
  // session it spawned — belongs to this rule. Don't filter by sessionId; if
  // we did, subagent tool calls would silently fall on the floor and the
  // progress UI would look frozen while the subagent is grinding.
  void sessionId;

  if (part.type === "tool") {
    if (announcedTools.has(part.callID)) return;
    const input = (part.state.input ?? {}) as Record<string, unknown>;
    if (Object.keys(input).length === 0) {
      // Wait for the input to actually arrive — the next update will have it.
      return;
    }
    announcedTools.add(part.callID);
    const name = mapOpencodeToolName(part.tool);
    onActivity({ kind: "tool", name, detail: summarizeOpencodeToolPart(part) });
  } else if (part.type === "text") {
    const trimmed = part.text.trim();
    if (trimmed) onActivity({ kind: "text", detail: truncate(trimmed.replace(/\s+/g, " "), 120) });
  }
}

/** Translate opencode's tool names to the Claude-Code-shaped names that the CLI's
 *  progress renderer already knows how to format (so output is consistent across harnesses). */
function mapOpencodeToolName(name: string): string {
  switch (name) {
    case "bash": return "Bash";
    case "read": return "Read";
    case "grep": return "Grep";
    case "glob": return "Glob";
    case "list": return "Glob";
    case "write": return "Write";
    case "edit": return "Edit";
    default:
      // MCP tools come through as `<server>_<tool>` in opencode; translate to mcp__<server>__<tool>.
      if (name.startsWith("revu_")) return `mcp__revu__${name.slice("revu_".length)}`;
      return name;
  }
}

function summarizeOpencodeToolPart(part: { tool: string; state: { input?: unknown } }): string {
  const i = (part.state.input ?? {}) as Record<string, unknown>;
  if (part.tool === "bash" && typeof i["command"] === "string") {
    return truncate((i["command"] as string).replace(/\s+/g, " "), 90);
  }
  if (part.tool === "read" && typeof i["filePath"] === "string") return i["filePath"] as string;
  if (part.tool === "grep" && typeof i["pattern"] === "string") {
    const path = typeof i["path"] === "string" ? ` in ${i["path"]}` : "";
    return `${i["pattern"]}${path}`;
  }
  if ((part.tool === "glob" || part.tool === "list") && typeof i["pattern"] === "string") {
    return i["pattern"] as string;
  }
  if (part.tool.startsWith("revu_")) {
    if (typeof i["severity"] === "string" && typeof i["path"] === "string") {
      const line = typeof i["line"] === "number" ? `:${i["line"]}` : "";
      return `${i["severity"]} ${i["path"]}${line}`;
    }
    if (typeof i["path"] === "string") return i["path"] as string;
  }
  try {
    return truncate(JSON.stringify(i), 90);
  } catch {
    return "";
  }
}

/** Variant of the scaffold system prompt that tells the agent to use
 *  `mcp__revu__write_rule_file` (sidecar tool) instead of opencode's built-in `write`. */
function buildOpencodeScaffoldSystemPrompt(force: boolean): string {
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

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const p = addr.port;
        srv.close(() => resolve(p));
      } else {
        srv.close();
        reject(new Error("could not allocate free port for opencode server"));
      }
    });
  });
}

function formatOpencodeError(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const e = err as { name?: string; data?: { message?: string; providerID?: string } };
    const msg = e.data?.message ?? e.name ?? "unknown error";
    const provider = e.data?.providerID ? ` [${e.data.providerID}]` : "";
    return `opencode${provider}: ${msg}`;
  }
  return `opencode: ${String(err)}`;
}

function formatThrown(e: unknown): string {
  const msg = (e as Error)?.message ?? String(e);
  if (/ENOENT|spawn opencode/i.test(msg)) {
    return "opencode binary not found on PATH. Install opencode (https://opencode.ai/docs/install/) before using --harness opencode.";
  }
  return msg;
}

function errorResult(ruleId: string, start: number, message: string): ReviewResult {
  return { ruleId, ok: false, durationMs: Date.now() - start, errorMessage: message };
}

function timeoutResult(ruleId: string, start: number, timeoutMs?: number): ReviewResult {
  return {
    ruleId,
    ok: false,
    durationMs: Date.now() - start,
    errorMessage: `timed out after ${timeoutMs}ms`,
    timedOut: true,
  };
}

function scaffoldError(start: number, filesWritten: string[], message: string): ScaffoldResult {
  return { ok: false, durationMs: Date.now() - start, filesWritten, errorMessage: message };
}

function scaffoldTimeoutResult(start: number, filesWritten: string[], timeoutMs?: number): ScaffoldResult {
  return {
    ok: false,
    durationMs: Date.now() - start,
    filesWritten,
    errorMessage: `timed out after ${timeoutMs}ms`,
    timedOut: true,
  };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
