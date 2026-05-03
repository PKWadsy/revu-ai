import { z } from "zod";

export const ReportFindingShape = {
  severity: z
    .enum(["aesthetic", "low", "medium", "high", "critical"])
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

export const MARK_RESOLVED_DESCRIPTION = `Mark a previously-reported finding as resolved.
Use this when reviewing prior findings provided in your system prompt: if the new commits in this PR have addressed an issue you flagged on a previous run, call this tool with the prior finding's fingerprint.
Do NOT use this tool for findings that are still open at the same location — just stay silent and the runner will keep them open.
Do NOT use this tool for findings that have moved to a new location — instead emit a fresh \`report_finding\` with the prior fingerprint passed via \`priorFp\`.`;

export const REPORT_FINDING_DESCRIPTION = `Report a code-review finding to the revu-ai runner.
Call this tool once for each issue you find. The runner aggregates findings across all reviewers.
Severity guidance:
  aesthetic = nit / style preference
  low       = minor smell, easy to live with
  medium    = should fix; not a bug yet but degrades the codebase
  high      = clearly wrong; will cause bugs or regressions
  critical  = will break production, security issue, or data loss
Do NOT report findings outside the scope of your assigned rules.`;
