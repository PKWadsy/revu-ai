import type { ReviewTarget } from "../types.js";

export interface ReviewActivity {
  /** "tool" for tool-use, "text" for assistant prose. */
  kind: "tool" | "text";
  /** For tool: tool name (e.g. "Bash", "Read", "mcp__revu__report_finding"). */
  name?: string;
  /** Brief one-line summary suitable for terminal printing. */
  detail: string;
}

export interface ReviewInput {
  ruleId: string;
  rulesFilePath: string;
  rulesContent: string;
  reviewTarget: ReviewTarget;
  repoRoot: string;
  mcp: { url: string; authToken: string };
  /** Hard wall-clock cutoff for this single agent run. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Optional progress callback — providers should call this for tool use / text turns. */
  onActivity?: (activity: ReviewActivity) => void;
}

export interface ReviewResult {
  ruleId: string;
  ok: boolean;
  durationMs: number;
  errorMessage?: string;
  /** True when the agent was stopped by the per-rule timeout. */
  timedOut?: boolean;
}

export interface ReviewAgent {
  readonly name: string;
  run(input: ReviewInput): Promise<ReviewResult>;
}

export interface ReviewAgentFactory {
  (cfg: { model?: string }): ReviewAgent;
}
