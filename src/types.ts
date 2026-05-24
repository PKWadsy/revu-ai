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
  /** Glob patterns (repo-root-relative) specifying which changed files this rule applies to.
   *  Parsed from the YAML frontmatter `files:` field. When absent, the rule applies to all changed files. */
  filePatterns?: string[];
}

export interface RuleResult {
  id: string;
  path: string;
  ok: boolean;
  durationMs: number;
  findingCount: number;
  /** Count of `report_review_summary` calls the agent emitted via the MCP sidecar.
   *  Expected to be exactly 1 for a healthy review. 0 means the agent never
   *  signed off — usually a symptom of a broken / silent agent — and surfaces
   *  as an "incomplete review" warning. >1 means the agent called it multiple
   *  times; only the first is kept. Always present on non-skipped rules. */
  summaryCount: number;
  /** Count of `report_check` calls the agent emitted — incremental compliance
   *  notes. No required minimum; high values just mean the agent showed its
   *  working. */
  checkCount: number;
  errorMessage?: string;
  /** True if this rule was stopped by the per-rule timeout. */
  timedOut?: boolean;
  /** True if this rule was skipped because no changed files matched its `files:` patterns. */
  skipped?: boolean;
  /** Observability counters from the provider — text chars emitted and
   *  report_finding tool calls observed. The pretty output surfaces a warning
   *  when textChars is high but findingCount is 0 (model wrote findings as
   *  prose instead of calling the MCP tool). Absent for skipped rules and for
   *  providers that don't report them. */
  diagnostics?: {
    textChars: number;
    findingToolCalls: number;
  };
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

export interface Check {
  ruleId: string;
  /** Repo-relative file path the agent verified. */
  path: string;
  line?: number;
  lineEnd?: number;
  /** What was verified and the evidence that it complies with the rule. */
  message: string;
  category?: string;
}

export interface ReviewSummary {
  ruleId: string;
  /** Agent's explicit declaration. "pass" = no findings reported for this rule;
   *  "concerns" = one or more findings reported. The runner cross-checks this
   *  against the recorded finding count. */
  outcome: "pass" | "concerns";
  /** Concrete description of what the agent examined (files, behaviours, areas). */
  checked: string;
  /** Why the outcome holds, tied to what was checked. */
  rationale: string;
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
  /** Per-rule review summaries — one per rule that called `report_review_summary`.
   *  A rule with no entry here is flagged as a possibly-incomplete review. */
  summaries: ReviewSummary[];
  /** All compliance checks the agents emitted via `report_check`. Granular
   *  positive evidence; not findings, not subject to resolution. */
  checks: Check[];
}

export interface RevuConfig {
  pattern: string;
  base?: string;
  workingTree: boolean;
  staged: boolean;
  /** The agent harness driving the reviewer. Default `claude-code`. `opencode` lets you
   *  swap in any provider/model opencode supports (xai, google, anthropic, …). */
  harness: string;
  /** AI provider for harnesses that support multiple (e.g. opencode). Ignored by
   *  single-provider harnesses like `claude-code`. */
  provider?: string;
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
