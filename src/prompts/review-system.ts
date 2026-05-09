import type { Finding, ReviewTarget } from "../types.js";

export function buildSystemPrompt(args: {
  ruleId: string;
  rulesContent: string;
  reviewTarget: ReviewTarget;
  priorFindings?: Finding[];
  priorHeadSha?: string;
}): string {
  const inspectHint = inspectionHint(args.reviewTarget);
  const priorBlock = renderPriorFindingsBlock(args);

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
  - priorFp: ONLY when this is a moved version of a finding listed in the prior findings below — pass that finding's fingerprint so the runner can correlate them.

Severity guidance:
  aesthetic = nit / style preference
  low       = minor smell, easy to live with
  medium    = should fix; not yet a bug but degrades the codebase
  high      = clearly wrong; will cause bugs or regressions
  critical  = will break production, security issue, or data loss

# Constraints

- Do NOT modify any files.
- Do NOT report findings outside the scope of the <rules> below.
- Do NOT include a final summary or commentary about what you reviewed; just call tools and stop. The runner doesn't read your text output.
- Do NOT delegate to subagents (no \`task\` / \`Task\` tool, no agent dispatch). Run every \`git\`, \`Read\`, \`Grep\`, \`Glob\` call yourself in this session — subagent calls run silently to the runner's progress log, give the impression of a stuck agent, and cost extra tokens for no review benefit. The single rule scope is small enough to review directly.
- If you find nothing, just stop. No "all clear" message needed.
${priorBlock}
<rules>
${args.rulesContent.trim()}
</rules>
`;
}

function renderPriorFindingsBlock(args: {
  reviewTarget: ReviewTarget;
  priorFindings?: Finding[];
  priorHeadSha?: string;
}): string {
  const priors = args.priorFindings ?? [];
  if (priors.length === 0) return "";

  const oldSha = args.priorHeadSha ?? "(unknown)";
  const headHint = args.reviewTarget.mode === "ref-range"
    ? args.reviewTarget.head
    : args.reviewTarget.mode === "staged"
      ? "the staged changes"
      : "the working tree";

  // Trim each prior finding to just the fields the agent needs to recognise it.
  const slim = priors.map((f) => ({
    fingerprint: f.fingerprint,
    severity: f.severity,
    path: f.path,
    ...(f.line !== undefined ? { line: f.line } : {}),
    ...(f.lineEnd !== undefined ? { lineEnd: f.lineEnd } : {}),
    message: f.message,
    ...(f.category !== undefined ? { category: f.category } : {}),
  }));

  return `
# Previously reported findings (this rule)

A prior run of THIS rule, against commit \`${oldSha}\`, reported the findings below. The current target is ${headHint}. Use \`git diff ${oldSha}..${args.reviewTarget.mode === "ref-range" ? args.reviewTarget.head : "HEAD"}\` (or any narrower diff) to see what's changed since then.

For EACH prior finding, decide:

- **Resolved** — the new commits address the issue (offending code removed, fixed, or made acceptable). Call \`mcp__revu__mark_finding_resolved\` with the prior \`fingerprint\` and \`reason="fixed"\`.
- **No longer applicable** — the file was deleted, the rule's premise no longer holds, etc. Call \`mcp__revu__mark_finding_resolved\` with \`reason="stale"\`.
- **Still open at the same location** — DO NOTHING. The runner keeps the prior open status; do NOT re-emit a \`report_finding\` for it.
- **Still open but at a different location** (line moved, code shifted) — call \`mcp__revu__report_finding\` for the NEW location with \`priorFp\` set to the prior fingerprint.

Then, additionally, scan the diff for GENUINELY new findings (not in the prior list) and \`report_finding\` for those with \`priorFp\` unset.

## Prior findings JSON

\`\`\`json
${JSON.stringify(slim, null, 2)}
\`\`\`

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
