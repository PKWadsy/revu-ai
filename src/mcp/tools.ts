import { z } from "zod";
import { SEVERITIES } from "../types.js";

export const ReportFindingShape = {
  severity: z
    .enum(SEVERITIES)
    .describe("Severity of the finding."),
  path: z.string().min(1).describe("Repo-relative file path, forward-slash separated."),
  line: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("1-indexed line number where the issue starts."),
  lineEnd: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("1-indexed line number where the issue ends. If set, line must also be set."),
  message: z.string().min(1).describe("Human-readable description of the issue."),
  category: z.string().optional().describe("Optional free-form category tag."),
  priorFp: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Set ONLY when this finding is a moved version of a finding that was reported in a previous run (line/location shifted but it's the same logical issue). Pass the prior finding's fingerprint here so the runner can correlate them.",
    ),
} as const;

export const ReportFindingObject = z.object(ReportFindingShape);
export type ReportFindingInput = z.infer<typeof ReportFindingObject>;

export const MarkResolvedShape = {
  fingerprint: z
    .string()
    .min(1)
    .describe("The fingerprint of the prior finding being marked resolved."),
  reason: z
    .enum(["fixed", "stale"])
    .optional()
    .describe(
      "Why this finding is being marked resolved. `fixed` = the new commits address it. `stale` = the rule's premise no longer holds (file deleted, etc.). Defaults to `fixed`.",
    ),
} as const;

export const MarkResolvedObject = z.object(MarkResolvedShape);
export type MarkResolvedInput = z.infer<typeof MarkResolvedObject>;

export const MARK_RESOLVED_DESCRIPTION = `Mark a previously-reported finding as RESOLVED — one of the two ways to account for a prior finding.
Use this when the current changes have addressed an issue you flagged on a previous run: pass the prior finding's fingerprint and a reason — \`fixed\` (the new commits address it) or \`stale\` (the rule's premise no longer holds: file deleted, etc.). The runner strikes the existing PR comment through.
This is REQUIRED accounting, not optional: every prior finding listed in your system prompt must be either resolved (this tool) or confirmed still-open (\`mark_finding_open\`, or \`report_finding\` with \`priorFp\` if it moved). A prior finding you leave untouched makes the whole review INCOMPLETE and it will be rejected.`;

export const MarkOpenShape = {
  fingerprint: z
    .string()
    .min(1)
    .describe("The fingerprint of the prior finding you are confirming is STILL open and unaddressed."),
} as const;

export const MarkOpenObject = z.object(MarkOpenShape);
export type MarkOpenInput = z.infer<typeof MarkOpenObject>;

export const MARK_OPEN_DESCRIPTION = `Confirm that a previously-reported finding is STILL OPEN and unaddressed — one of the two ways to account for a prior finding.
Use this for each prior finding (listed in your system prompt) whose issue the current changes have NOT fixed and whose location is unchanged. It keeps the existing PR comment in place (no duplicate is posted) and keeps the finding counted as open.
If the finding is still open but the code MOVED to a different line, use \`report_finding\` with \`priorFp\` set to the prior fingerprint instead (so the comment can be repointed). If the finding has been fixed or no longer applies, use \`mark_finding_resolved\` instead.
Accounting for EVERY prior finding (open or resolved) is REQUIRED — a review that leaves any prior finding untouched is rejected as incomplete, the same as a crashed review.`;

export const ReportCheckShape = {
  path: z
    .string()
    .min(1)
    .describe("Repo-relative file path you just verified, forward-slash separated."),
  line: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Optional 1-indexed line where the verified area starts."),
  lineEnd: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Optional 1-indexed line where the verified area ends. If set, line must also be set."),
  message: z
    .string()
    .min(1)
    .describe(
      "What you verified and why it complies with the rule. Be specific — name the rule clause / contract / property you checked against. Example: 'public exports are unchanged: signatures of `Foo`, `Bar` in src/api.ts:45-92 match prior shape.'",
    ),
  category: z.string().optional().describe("Optional free-form category tag (same field as report_finding)."),
} as const;

export const ReportCheckObject = z.object(ReportCheckShape);
export type ReportCheckInput = z.infer<typeof ReportCheckObject>;

export const REPORT_CHECK_DESCRIPTION = `Record a compliance check — a positive verification that some specific part of the change conforms to the rule. Call this as you go, NOT just at the end.
Checks are NOT findings: they need no resolution, do not contribute to severity, and do not affect exit codes. Their purpose is to give the user live, granular evidence that the agent actually inspected the code (rather than guessing or skipping). Each call is a single "yep, I verified X and it's good because Y" note.
Use freely as you work through the diff — one call per concrete thing you've verified. If you read a file and concluded that nothing in it violates the rule, that's worth a check. If you traced a contract through three files and they line up, that's a check (or several).
Aim for specific, evidence-backed messages, not vague ones. Bad: "looks good." Good: "no new global state introduced in src/runner.ts:95-160 — the new filePatterns branch is local to the rule loop."
\`report_review_summary\` is still required at the end as the one-shot sign-off; \`report_check\` is the running commentary that gets you there.`;

export const ReportReviewSummaryShape = {
  outcome: z
    .enum(["pass", "concerns"])
    .describe(
      "`pass` if you reported zero findings via report_finding for this rule; `concerns` if you reported one or more. This is your explicit declaration — the runner cross-checks it against the recorded finding count.",
    ),
  checked: z
    .string()
    .min(1)
    .describe(
      "A concrete description of what you actually examined to reach your conclusion. List specific files, functions, or behaviors — not generic phrases like 'the diff' or 'the changes'. Example: 'src/runner.ts lines 95-160: the new filePatterns guard branch and its three failure paths; plus the corresponding test cases in tests/runner.test.ts.'",
    ),
  rationale: z
    .string()
    .min(1)
    .describe(
      "A brief explanation tying what you checked to why the outcome holds. For `pass`, state which aspect of the rule the code satisfies and on what evidence. For `concerns`, summarise any context not captured in individual findings. 1-3 sentences.",
    ),
} as const;

export const ReportReviewSummaryObject = z.object(ReportReviewSummaryShape);
export type ReportReviewSummaryInput = z.infer<typeof ReportReviewSummaryObject>;

export const REPORT_REVIEW_SUMMARY_DESCRIPTION = `Report a one-line review summary for this rule. REQUIRED: every review run MUST call this tool exactly once before stopping.
The runner uses this call to confirm the agent actually performed the review (vs. silently exiting, writing findings as prose, or never reaching the MCP). A run that emits no summary is flagged as a possibly-incomplete review.
Call this AFTER you have reported any findings via \`report_finding\` (and any prior-finding resolutions via \`mark_finding_resolved\`). Pass \`outcome\` = "pass" when you reported zero findings, or "concerns" when you reported one or more.
If the rule is out of scope for the diff (e.g. the rule covers Python tests but no .py files changed), still call this with \`outcome\` = "pass" and a \`checked\` / \`rationale\` describing that you inspected the diff and concluded the rule does not apply.`;

export const WriteRuleFileShape = {
  path: z
    .string()
    .min(1)
    .describe(
      "Repo-relative path of the rule file to create. MUST end in `.revu.md`. Globals go in `.revu/<topic>.revu.md`; locals go alongside the thing they cover as `<dir>/<topic>.revu.md`.",
    ),
  content: z
    .string()
    .describe("Full Markdown content of the rule file."),
} as const;

export const WriteRuleFileObject = z.object(WriteRuleFileShape);
export type WriteRuleFileInput = z.infer<typeof WriteRuleFileObject>;

export const WRITE_RULE_FILE_DESCRIPTION = `Create a revu-ai rule file at the given repo-relative path.
The path MUST end in \`.revu.md\` and resolve inside the repository (server enforces this; out-of-tree paths are rejected).
Globals: \`.revu/<topic>.revu.md\`. Locals: \`<sub-service-dir>/<topic>.revu.md\` directly inside that directory.
Use this instead of any built-in file-writing tool — only this path is safety-checked by revu-ai.`;

export const REPORT_FINDING_DESCRIPTION = `Report a code-review finding to the revu-ai runner.
Call this tool once for each issue you find. The runner aggregates findings across all reviewers.
Severity guidance:
  aesthetic = nit / style preference
  low       = minor smell, easy to live with
  medium    = should fix; not a bug yet but degrades the codebase
  high      = clearly wrong; will cause bugs or regressions
  critical  = will break production, security issue, or data loss
Do NOT report findings outside the scope of your assigned rules.`;
