import { isAbsolute, relative, resolve } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { buildSystemPrompt } from "../prompts/review-system.js";
import { buildUserPrompt } from "../prompts/review-user.js";
import { buildInitSystemPrompt } from "../prompts/init-system.js";
import { buildInitUserPrompt } from "../prompts/init-user.js";
import type {
  ReviewActivity,
  ReviewAgent,
  ReviewAgentFactory,
  ReviewInput,
  ReviewResult,
  ScaffoldAgentFactory,
  ScaffoldInput,
  ScaffoldResult,
} from "./types.js";

const ALWAYS_ALLOWED_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "mcp__revu__report_finding",
];

const RESTRICTED_TOOLSET = ["Read", "Grep", "Glob", "Bash"];

export const claudeCodeProvider: ReviewAgentFactory = (cfg) => ({
  name: "claude-code",
  async run(input: ReviewInput): Promise<ReviewResult> {
    const start = Date.now();
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

    try {
      const q = query({
        prompt: buildUserPrompt(input.reviewTarget),
        options: {
          cwd: input.repoRoot,
          ...(cfg.model ? { model: cfg.model } : {}),
          systemPrompt: buildSystemPrompt({
            ruleId: input.ruleId,
            rulesContent: input.rulesContent,
            reviewTarget: input.reviewTarget,
          }),
          tools: RESTRICTED_TOOLSET,
          allowedTools: ALWAYS_ALLOWED_TOOLS,
          mcpServers: {
            revu: {
              type: "http",
              url: input.mcp.url,
              headers: {
                Authorization: `Bearer ${input.mcp.authToken}`,
                "X-Revu-Rule-Id": input.ruleId,
              },
            },
          },
          canUseTool: async (toolName, toolInput) => {
            if (toolName === "Bash") {
              const command = typeof toolInput.command === "string" ? toolInput.command : "";
              if (isReadOnlyShellCommand(command)) {
                return { behavior: "allow", updatedInput: toolInput };
              }
              return {
                behavior: "deny",
                message: `Bash command rejected for safety: revu-ai reviewers may only run read-only commands (git diff/log/show/status, cat, head, tail, ls, wc, find). Got: ${truncate(command, 200)}`,
              };
            }
            return { behavior: "allow", updatedInput: toolInput };
          },
          permissionMode: "default",
          settingSources: [],
          persistSession: false,
          abortController: abort,
          stderr: (data: string) => {
            if (process.env.REVU_DEBUG) {
              process.stderr.write(`[${input.ruleId}] ${data}`);
            }
          },
        },
      });

      // Drain the message stream. Findings flow through the MCP sidecar; we
      // watch for a `result` message so we can surface SDK errors meaningfully.
      // The agent SDK throws on non-zero subprocess exit AFTER emitting `result`,
      // so we capture the result-derived error first and prefer it in the catch.
      let resultErrorMessage: string | undefined;

      try {
        for await (const msg of q) {
          const m = msg as {
            type?: string;
            subtype?: string;
            errors?: string[];
            is_error?: boolean;
            result?: string;
            num_turns?: number;
            message?: { content?: unknown };
          };
          if (process.env.REVU_DEBUG) {
            if (m.type === "result") {
              process.stderr.write(
                `[${input.ruleId}] RESULT subtype=${m.subtype} is_error=${m.is_error} num_turns=${m.num_turns} errors=${JSON.stringify(m.errors)} result=${JSON.stringify(m.result)?.slice(0, 600)}\n`,
              );
            } else if (m.type === "assistant") {
              process.stderr.write(
                `[${input.ruleId}] ASSISTANT content=${JSON.stringify(m.message?.content)?.slice(0, 800)}\n`,
              );
            } else if (m.type === "system") {
              process.stderr.write(`[${input.ruleId}] system\n`);
            } else {
              process.stderr.write(`[${input.ruleId}] msg.type=${m.type}\n`);
            }
          }
          if (m.type === "assistant" && input.onActivity) {
            emitAssistantActivity(m.message?.content, input.onActivity);
          }
          if (m.type === "result" && (m.is_error || m.subtype !== "success")) {
            const text = m.result ?? m.errors?.join("; ") ?? "unknown error";
            resultErrorMessage = m.subtype === "success"
              ? text
              : `${m.subtype ?? "error"}: ${text}`;
          }
        }
      } catch (streamErr) {
        // If the stream throws but we already captured a meaningful result-level
        // error, that's the one to surface — the stream throw is a downstream
        // symptom of the same condition.
        if (!resultErrorMessage) {
          resultErrorMessage = (streamErr as Error).message ?? String(streamErr);
        }
      }

      if (timedOut) {
        return {
          ruleId: input.ruleId,
          ok: false,
          durationMs: Date.now() - start,
          errorMessage: `timed out after ${input.timeoutMs}ms`,
          timedOut: true,
        };
      }
      if (resultErrorMessage) {
        return {
          ruleId: input.ruleId,
          ok: false,
          durationMs: Date.now() - start,
          errorMessage: resultErrorMessage,
        };
      }
      return { ruleId: input.ruleId, ok: true, durationMs: Date.now() - start };
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
    }
  },
});

const SAFE_LEADING_BINS = new Set([
  "git",
  "cat",
  "head",
  "tail",
  "ls",
  "wc",
  "find",
  "pwd",
  "echo",
  "grep",
  "rg",
  "awk",
  "sed",
  "sort",
  "uniq",
  "tr",
  "cut",
  "tee",
  "true",
  "false",
  "test",
  "[",
  "stat",
  "file",
  "basename",
  "dirname",
  "realpath",
  "readlink",
]);

const FORBIDDEN_GIT_SUBCOMMANDS = new Set([
  "push",
  "commit",
  "checkout",
  "reset",
  "rebase",
  "merge",
  "pull",
  "fetch",
  "clone",
  "tag",
  "rm",
  "restore",
  "stash",
  "apply",
  "am",
  "cherry-pick",
  "switch",
  "remote",
  "init",
  "clean",
  "gc",
  "prune",
  "config",
  "submodule",
  "worktree",
  "filter-branch",
  "filter-repo",
  "update-ref",
  "update-index",
  "hash-object",
]);

export function isReadOnlyShellCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.includes("`")) return false;           // backtick command substitution
  if (/\$\(/.test(trimmed)) return false;            // $(...) command substitution
  if (/[><]/.test(trimmed)) return false;            // redirects
  if (/(^|\s)(&&|\|\||;|&)(\s|$)/.test(trimmed)) return false; // chained / backgrounded

  // Allow piping between safe binaries.
  const segments = trimmed.split("|").map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return false;

  for (const seg of segments) {
    const tokens = seg.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return false;
    const bin = (tokens[0] ?? "").replace(/^.*\//, "");
    if (!SAFE_LEADING_BINS.has(bin)) return false;
    if (bin === "git") {
      const sub = (tokens[1] ?? "").toLowerCase();
      if (!sub || sub.startsWith("-")) return false;
      if (FORBIDDEN_GIT_SUBCOMMANDS.has(sub)) return false;
    }
  }
  return true;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function emitAssistantActivity(content: unknown, onActivity: (a: ReviewActivity) => void): void {
  if (!Array.isArray(content)) return;
  for (const block of content as Array<{ type?: string; name?: string; input?: unknown; text?: string }>) {
    if (block.type === "tool_use" && typeof block.name === "string") {
      onActivity({
        kind: "tool",
        name: block.name,
        detail: summarizeToolInput(block.name, block.input),
      });
    } else if (block.type === "text" && typeof block.text === "string") {
      const trimmed = block.text.trim();
      if (trimmed) onActivity({ kind: "text", detail: truncate(trimmed.replace(/\s+/g, " "), 120) });
    }
  }
}

function summarizeToolInput(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  if (name === "Bash" && typeof i["command"] === "string") {
    return truncate((i["command"] as string).replace(/\s+/g, " "), 90);
  }
  if (name === "Read" && typeof i["file_path"] === "string") {
    return i["file_path"] as string;
  }
  if (name === "Grep" && typeof i["pattern"] === "string") {
    const path = typeof i["path"] === "string" ? ` in ${i["path"]}` : "";
    return `${i["pattern"]}${path}`;
  }
  if (name === "Glob" && typeof i["pattern"] === "string") {
    return i["pattern"] as string;
  }
  if (name === "Write" && typeof i["file_path"] === "string") {
    return i["file_path"] as string;
  }
  if (name.startsWith("mcp__")) {
    // Most useful for our own report_finding tool.
    if (typeof i["severity"] === "string" && typeof i["path"] === "string") {
      const line = typeof i["line"] === "number" ? `:${i["line"]}` : "";
      return `${i["severity"]} ${i["path"]}${line}`;
    }
  }
  // Generic fallback: short stringify.
  try {
    const s = JSON.stringify(i);
    return truncate(s, 90);
  } catch {
    return "";
  }
}

/**
 * The scaffold agent is allowed to call `Write`, but only on `.revu.md` files
 * that resolve to a path inside the repo root. Anything else is denied.
 */
export function isAllowedRuleFileWrite(repoRoot: string, filePath: unknown): boolean {
  if (typeof filePath !== "string" || filePath.length === 0) return false;
  if (!/\.revu\.md$/.test(filePath)) return false;
  const abs = isAbsolute(filePath) ? filePath : resolve(repoRoot, filePath);
  const rel = relative(resolve(repoRoot), abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
  return true;
}

const SCAFFOLD_TOOLSET = ["Read", "Grep", "Glob", "Bash", "Write"];
const SCAFFOLD_ALWAYS_ALLOWED = ["Read", "Grep", "Glob"];

export const claudeCodeScaffoldProvider: ScaffoldAgentFactory = (cfg) => ({
  name: "claude-code",
  async run(input: ScaffoldInput): Promise<ScaffoldResult> {
    const start = Date.now();
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

    try {
      const q = query({
        prompt: buildInitUserPrompt({ repoRoot: input.repoRoot, force: input.force }),
        options: {
          cwd: input.repoRoot,
          ...(cfg.model ? { model: cfg.model } : {}),
          systemPrompt: buildInitSystemPrompt({ force: input.force }),
          tools: SCAFFOLD_TOOLSET,
          allowedTools: SCAFFOLD_ALWAYS_ALLOWED,
          canUseTool: async (toolName, toolInput) => {
            if (toolName === "Bash") {
              const command = typeof toolInput["command"] === "string" ? (toolInput["command"] as string) : "";
              if (isReadOnlyShellCommand(command)) {
                return { behavior: "allow", updatedInput: toolInput };
              }
              return {
                behavior: "deny",
                message: `Bash command rejected for safety: scaffold may only run read-only commands. Got: ${truncate(command, 200)}`,
              };
            }
            if (toolName === "Write") {
              if (isAllowedRuleFileWrite(input.repoRoot, toolInput["file_path"])) {
                return { behavior: "allow", updatedInput: toolInput };
              }
              return {
                behavior: "deny",
                message:
                  "scaffold may only Write `.revu.md` files inside the repository. Refusing this path. " +
                  "Globals go in `.revu/<topic>.revu.md`; locals go alongside the thing they cover as `<dir>/<topic>.revu.md`.",
              };
            }
            if (toolName === "Edit" || toolName === "MultiEdit" || toolName === "NotebookEdit") {
              return {
                behavior: "deny",
                message: `scaffold must use Write (not ${toolName}) when creating rule files.`,
              };
            }
            return { behavior: "allow", updatedInput: toolInput };
          },
          permissionMode: "default",
          settingSources: [],
          persistSession: false,
          abortController: abort,
          stderr: (data: string) => {
            if (process.env.REVU_DEBUG) {
              process.stderr.write(`[scaffold] ${data}`);
            }
          },
        },
      });

      let resultErrorMessage: string | undefined;

      try {
        for await (const msg of q) {
          const m = msg as {
            type?: string;
            subtype?: string;
            errors?: string[];
            is_error?: boolean;
            result?: string;
            num_turns?: number;
            message?: { content?: unknown };
          };
          if (process.env.REVU_DEBUG) {
            if (m.type === "result") {
              process.stderr.write(
                `[scaffold] RESULT subtype=${m.subtype} is_error=${m.is_error} num_turns=${m.num_turns} errors=${JSON.stringify(m.errors)} result=${JSON.stringify(m.result)?.slice(0, 600)}\n`,
              );
            } else if (m.type === "assistant") {
              process.stderr.write(
                `[scaffold] ASSISTANT content=${JSON.stringify(m.message?.content)?.slice(0, 800)}\n`,
              );
            } else {
              process.stderr.write(`[scaffold] msg.type=${m.type}\n`);
            }
          }
          if (m.type === "assistant") {
            // Stream activity AND notice successful Write tool_use blocks so we can
            // record what got written and emit live "✱ created ..." lines.
            const content = m.message?.content;
            if (Array.isArray(content)) {
              for (const block of content as Array<{ type?: string; name?: string; input?: unknown }>) {
                if (block.type === "tool_use" && block.name === "Write") {
                  const fp = (block.input as { file_path?: unknown } | undefined)?.file_path;
                  if (typeof fp === "string" && isAllowedRuleFileWrite(input.repoRoot, fp)) {
                    const abs = isAbsolute(fp) ? fp : resolve(input.repoRoot, fp);
                    const rel = relative(resolve(input.repoRoot), abs).split("\\").join("/");
                    filesWritten.push(rel);
                    input.onFileWritten?.(rel);
                  }
                }
              }
            }
            if (input.onActivity) emitAssistantActivity(content, input.onActivity);
          }
          if (m.type === "result" && (m.is_error || m.subtype !== "success")) {
            const text = m.result ?? m.errors?.join("; ") ?? "unknown error";
            resultErrorMessage = m.subtype === "success"
              ? text
              : `${m.subtype ?? "error"}: ${text}`;
          }
        }
      } catch (streamErr) {
        if (!resultErrorMessage) {
          resultErrorMessage = (streamErr as Error).message ?? String(streamErr);
        }
      }

      if (timedOut) {
        return {
          ok: false,
          durationMs: Date.now() - start,
          filesWritten,
          errorMessage: `timed out after ${input.timeoutMs}ms`,
          timedOut: true,
        };
      }
      if (resultErrorMessage) {
        return {
          ok: false,
          durationMs: Date.now() - start,
          filesWritten,
          errorMessage: resultErrorMessage,
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
        errorMessage: (e as Error).message ?? String(e),
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  },
});
