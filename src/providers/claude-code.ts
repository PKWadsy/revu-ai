import { query } from "@anthropic-ai/claude-agent-sdk";
import { buildSystemPrompt } from "../prompts/review-system.js";
import { buildUserPrompt } from "../prompts/review-user.js";
import type {
  ReviewActivity,
  ReviewAgent,
  ReviewAgentFactory,
  ReviewInput,
  ReviewResult,
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
                message: `Bash command rejected for safety: revu reviewers may only run read-only commands (git diff/log/show/status, cat, head, tail, ls, wc, find). Got: ${truncate(command, 200)}`,
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
