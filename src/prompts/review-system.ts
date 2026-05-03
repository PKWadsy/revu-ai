import type { ReviewTarget } from "../types.js";

export function buildSystemPrompt(args: {
  ruleId: string;
  rulesContent: string;
  reviewTarget: ReviewTarget;
}): string {
  const inspectHint = inspectionHint(args.reviewTarget);
  return `You are a focused code reviewer for the rule "${args.ruleId}".

You evaluate the changes ONLY through the lens of the rules in the <rules> block below. If the changes are unrelated to those rules, finish your turn without reporting anything — silence is the correct outcome in that case.

# How to inspect the changes

Use git directly. Suggested commands:
${inspectHint}

You may also use Read, Grep, and Glob to inspect the broader codebase to *verify* whether something is actually a problem (e.g. "is this newly-exported symbol referenced anywhere?"). Read-only Bash is permitted; file edits are NOT.

# How to report findings

For each issue you find, call the MCP tool \`mcp__revu__report_finding\` with:
  - severity: one of "aesthetic", "low", "medium", "high", "critical"
  - path: repo-relative file path (forward slashes)
  - line: 1-indexed line number where the issue starts (optional)
  - lineEnd: 1-indexed line number where the issue ends (optional, requires line)
  - message: a clear, concise description of the issue and what to do about it
  - category: optional free-form category tag

Severity guidance:
  aesthetic = nit / style preference
  low       = minor smell, easy to live with
  medium    = should fix; not yet a bug but degrades the codebase
  high      = clearly wrong; will cause bugs or regressions
  critical  = will break production, security issue, or data loss

# Constraints

- Do NOT modify any files.
- Do NOT report findings outside the scope of the <rules> below.
- Do NOT include a final summary or commentary about what you reviewed; just call the tool for any findings and stop. The runner doesn't read your text output.
- If you find nothing, just stop. No "all clear" message needed.

<rules>
${args.rulesContent.trim()}
</rules>
`;
}

function inspectionHint(target: ReviewTarget): string {
  if (target.mode === "ref-range") {
    const { base, head } = target;
    return `  - \`git diff ${base}...${head}\` — full unified diff
  - \`git diff --stat ${base}...${head}\` — summary of changed files
  - \`git log ${base}..${head}\` — commit messages on the branch
  - \`git show <sha>\` — inspect a single commit
  - \`git diff ${base}...${head} -- <path>\` — focus on one file`;
  }
  if (target.mode === "working-tree") {
    return `  - \`git status\` — what's changed in the working tree
  - \`git diff HEAD\` — unified diff of all uncommitted changes
  - \`git diff HEAD -- <path>\` — focus on one file`;
  }
  return `  - \`git diff --staged\` — unified diff of staged changes
  - \`git diff --staged --stat\` — summary
  - \`git diff --staged -- <path>\` — focus on one file`;
}
