/** Single source of truth for severity levels, in increasing severity order.
 *  Every other severity-aware constant in the codebase derives from this. */
export const SEVERITIES = ["aesthetic", "low", "medium", "high", "critical"] as const;

export type Severity = (typeof SEVERITIES)[number];

export const SEVERITY_ORDER: Record<Severity, number> = Object.freeze(
  Object.fromEntries(SEVERITIES.map((s, i) => [s, i])),
) as Record<Severity, number>;

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
  /** Stable cross-run identity. sha256 of (ruleId|path|line|message), truncated to 12 chars. */
  fingerprint: string;
  /** Set when this finding evolved from a prior one (e.g. line moved). The post step uses
   *  this to look up the prior comment id and PATCH instead of POST. */
  priorFp?: string;
  /** Forge-native id of the comment representing this finding, populated by the post step
   *  after a successful create / patch. Opaque to the runner. */
  commentId?: number | string;
  /** First commit at which this finding was observed. Carried across runs via --prior-report. */
  firstSeenSha?: string;
  /** Most recent commit at which this finding was observed. */
  lastSeenSha?: string;
}

export interface Resolution {
  ruleId: string;
  /** Fingerprint of the prior finding the agent considers resolved. */
  fingerprint: string;
  reason: "fixed" | "stale";
  /** Commit at which the agent considered the finding resolved. */
  resolvedAtSha: string;
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
  /** Bumped to 2 when prior-run-aware features (resolutions, fingerprint, commentId) were added.
   *  Readers SHOULD accept v1 reports and treat missing fields as defaults. */
  schemaVersion: 2;
  runId: string;
  startedAt: string;
  completedAt: string;
  reviewTarget: ResolvedTarget & { mode: ReviewTarget["mode"] };
  rules: RuleResult[];
  findings: Finding[];
  /** Resolutions emitted by reviewers this run, OR carried forward from `--prior-report`. */
  resolutions: Resolution[];
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
  /** Path to a prior run's --output-file report. When present, reviewer agents see
   *  their rule's open prior findings as system-prompt context for cross-run reasoning. */
  priorReport?: string;
}
