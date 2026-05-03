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
} as const;

export const ReportFindingObject = z.object(ReportFindingShape);
export type ReportFindingInput = z.infer<typeof ReportFindingObject>;

export const REPORT_FINDING_DESCRIPTION = `Report a code-review finding to the revu-ai runner.
Call this tool once for each issue you find. The runner aggregates findings across all reviewers.
Severity guidance:
  aesthetic = nit / style preference
  low       = minor smell, easy to live with
  medium    = should fix; not a bug yet but degrades the codebase
  high      = clearly wrong; will cause bugs or regressions
  critical  = will break production, security issue, or data loss
Do NOT report findings outside the scope of your assigned rules.`;
