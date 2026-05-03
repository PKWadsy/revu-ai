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

export interface ScaffoldInput {
  repoRoot: string;
  /** If true, the agent may overwrite rule files it decides to (re)create. */
  force: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Same shape as the review path — useful for live progress streaming. */
  onActivity?: (activity: ReviewActivity) => void;
  /** Fires once per `.revu.md` file the agent successfully writes. */
  onFileWritten?: (relPath: string) => void;
}

export interface ScaffoldResult {
  ok: boolean;
  durationMs: number;
  /** Repo-relative paths of every `.revu.md` file the agent wrote. */
  filesWritten: string[];
  errorMessage?: string;
  timedOut?: boolean;
}

export interface ScaffoldAgent {
  readonly name: string;
  run(input: ScaffoldInput): Promise<ScaffoldResult>;
}

export interface ScaffoldAgentFactory {
  (cfg: { model?: string }): ScaffoldAgent;
}
