export type Severity = "aesthetic" | "low" | "medium" | "high" | "critical";

export const SEVERITY_ORDER: Record<Severity, number> = {
  aesthetic: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export interface RuleFile {
  ruleId: string;
  absPath: string;
  relPath: string;
  content: string;
}

export type ReviewTarget =
  | { mode: "ref-range"; base: string; head: string }
  | { mode: "working-tree" }
  | { mode: "staged" };

export interface ResolvedTarget {
  target: ReviewTarget;
  baseSha?: string;
  headSha?: string;
  changedFiles: string[];
}

export interface Finding {
  ruleId: string;
  severity: Severity;
  path: string;
  line?: number;
  lineEnd?: number;
  message: string;
  category?: string;
}

export interface RuleResult {
  id: string;
  path: string;
  ok: boolean;
  durationMs: number;
  findingCount: number;
  errorMessage?: string;
  /** True if this rule was stopped by the per-rule timeout. */
  timedOut?: boolean;
}

export interface RunReport {
  schemaVersion: 1;
  runId: string;
  startedAt: string;
  completedAt: string;
  reviewTarget: ResolvedTarget & { mode: ReviewTarget["mode"] };
  rules: RuleResult[];
  findings: Finding[];
}

export interface RevuConfig {
  pattern: string;
  base?: string;
  workingTree: boolean;
  staged: boolean;
  provider: string;
  model?: string;
  concurrency?: number;
  output: "pretty" | "json" | "github" | "auto";
  outputFile?: string;
  failOn: Severity;
  force: boolean;
  /** Per-agent wall-clock timeout in ms. Default 300_000 (5 minutes). */
  timeoutMs: number;
}
