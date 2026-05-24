# Changelog

All notable changes to `revu-ai` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project's pre-1.0 versioning treats minor bumps as breaking-change boundaries.

## 0.3.0 — 2026-05-24

### Breaking changes

- **`RunReport.schemaVersion` bumped from `2` to `3`.** New required fields on the contract: `summaryCount` and `checkCount` on every `RuleResult`; top-level `summaries: ReviewSummary[]` and `checks: Check[]` arrays. `revu-ai github post` accepts v1, v2, and v3 reports for back-compat.
- **Type exports added to the package's main export:** `Check`, `ReviewSummary`, `Resolution`. Consumers handling the new `RunReport.summaries` / `RunReport.checks` fields can now type them properly without reaching into `dist/types.js` paths.

### Added

- **`mcp__revu__report_review_summary` MCP tool — REQUIRED final sign-off.** Every review agent must call this exactly once before stopping; the call carries `outcome` ("pass" / "concerns"), `checked` (concrete description of what was inspected), and `rationale` (why the outcome holds). The runner uses the call's presence to detect agents that silently exited or never reached the MCP — a "no findings" run from an agent that didn't sign off is now flagged as a possibly-incomplete review rather than rendered as a clean tick.
- **`mcp__revu__report_check` MCP tool — incremental compliance evidence.** Agents call this as they work through the diff, once per concrete thing verified. Checks are NOT findings: they need no resolution, do not contribute to severity, and do not affect exit codes. The CLI streams a live `✓ <ruleId> <path>:<line> <message>` line for each check, and the final pretty output groups them under a per-rule "verified" block alongside the summary. The goal: a clean review now shows its working rather than just emitting a tick.
- **`RunReport.summaries` and `RunReport.checks` arrays** (additive). `RuleResult.summaryCount` and `RuleResult.checkCount` (always present on non-skipped rules).
- **Incomplete-review banner in pretty output.** When a healthy rule (not errored, not timed-out, not skipped) finishes without emitting a `report_review_summary`, a yellow banner names it explicitly so a "no findings" outcome can be trusted vs. treated as a possible false negative.

### Changed

- **Review system prompt overhauled.** New REQUIRED sections describe the two tools above and the order they should be called in. The earlier "If you find nothing, just stop" instruction is replaced with explicit sign-off guidance: even when a rule is out of scope for the diff, the agent must call `report_review_summary` with `outcome: "pass"` and a `checked` / `rationale` explaining why the rule doesn't apply.

## 0.2.2 — 2026-05-23

### Added

- **YAML frontmatter `files:` filter on `*.revu.md` rules.** Rules can scope themselves to a glob (or list of globs) via frontmatter; only changed files matching the glob are sent to the agent for that rule. Empty `files:` is fail-closed (the rule is skipped with a clear error) rather than silently running against the whole repo.
- **Diagnostic warning when an agent emits prose but reports 0 findings.** Both harnesses now track per-rule assistant prose length and `mcp__revu__report_finding` call counts; the pretty output flags any rule that produced >200 chars of prose without calling the tool. Catches the "model wrote findings as text instead of using the tool" failure mode observed with opencode + Grok.

## 0.2.1 — 2026-05-09

### Fixed

- **`revu-ai github post` tolerates very large PRs.** GitHub's diff endpoint returns `406 too_large` for any PR whose unified diff exceeds 20,000 lines, which previously crashed the post step (`Process completed with exit code 2`) and left the review unposted. We now catch that specific error, log a warning, and fall back to routing every finding through the top-level review body (no inline anchoring). The review still lands; the only loss is per-line gutter pinning on huge PRs.

## 0.2.0 — 2026-05-09

### Breaking changes

- **`--provider` semantics changed.** The flag previously selected the agent harness (`claude-code`); that role moved to a new `--harness` flag. `--provider` is now the AI-provider field, only meaningful for harnesses that support multiple providers (currently `opencode`). Same renames in `revu.config.json` (`provider` → `harness`, plus a new optional `provider`).
- The exported registry API renamed: `registerProvider` / `unregisterProvider` / `getProviderFactory` / `listProviders` → `registerHarness` / `unregisterHarness` / `getHarnessFactory` / `listHarnesses`. Plus the scaffold pair: `registerScaffoldProvider` → `registerScaffoldHarness`, `getScaffoldFactory` → `getScaffoldHarness`.
- `RevuConfig.provider: string` → `RevuConfig.harness: string` with a new optional `RevuConfig.provider?: string`.
- **`RunReport.schemaVersion` bumped from `1` to `2`.** The shape gains a required `Finding.fingerprint` (12-char sha256 prefix of `ruleId|path|line|message`), an optional `Finding.priorFp` for moved-finding correlation, an optional `Finding.commentId` populated by the github post step, and a top-level `resolutions: Resolution[]` array. Readers that consume `--output-file` JSON should accept v1 OR v2 (the post step does — see `src/forges/post-cmd.ts`).

### Added

- **opencode harness.** Drop in any provider/model [opencode](https://opencode.ai) supports — xAI Grok, Google Gemini, OpenAI, Anthropic-via-opencode, etc.
  ```bash
  revu-ai --harness opencode --provider xai    --model grok-4-1-fast-reasoning
  revu-ai --harness opencode --provider google  --model gemini-2.5-pro
  revu-ai init --harness opencode --provider google --model gemini-2.5-pro
  ```
  Requires the `opencode` binary on `PATH`. Set the relevant env var: `XAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`.
- **`mcp__revu__write_rule_file` sidecar tool** (scaffold mode only). Path-validates `.revu.md` writes inside the repo root; required for the opencode scaffold path since opencode lacks per-call tool gating.
- New shared util `src/scaffold-paths.ts` exporting `isAllowedRuleFileWrite` / `toRepoRelative` (lifted out of `claude-code.ts`).
- Cross-validation tests for the opencode bash allowlist (`tests/opencode-bash.test.ts`) — 43 cases asserting that every command the patterns intend to allow is also accepted by claude-code's stricter `isReadOnlyShellCommand`, plus adversarial inputs (redirects, chains, command substitution, mutators) the validator rejects.
- Test coverage added for `FindingsAggregator.markResolved` / `resolutionsFor` / `allResolutions` / `onResolution`, the `mark_finding_resolved` MCP tool, and the runner's `priorReport` input flow.

### Changed

- **`revu-ai github post`** — sequential PATCH calls now use per-call try/catch and continue through the loop on failure. Failures are logged to stderr with counts and reasons; the augmented report is always returned so the next run's `--prior-report` can dedup correctly. The `listReviewCommentsForReview` backfill is similarly resilient — a network blip there logs a warning instead of dropping the augmented report.
- Severity display maps (`SEV_BADGE` in `forges/render.ts`, `SEV_COLOR` / `SEV_LABEL` in `cli.ts`) now carry comments noting that `Record<Severity, …>` makes `SEVERITIES` (in `src/types.ts`) the single source of truth — adding a new severity fails typecheck at every map until it's extended.

### Safety notes

The opencode harness is a weaker bash boundary than claude-code's: opencode evaluates its `permission.bash` patterns with simple wildcards (`*` matches anything, including shell metacharacters), so a pattern like `"cat *"` cannot prevent `cat foo > /tmp/x`. Residual defenses are the reviewer system prompt (read-only commands only), `permission.edit: "deny"`, and the `"*": "deny"` catchall. The contract the agent is expected to respect is pinned by `tests/opencode-bash.test.ts`. Use the claude-code harness if you need stricter shell sandboxing.

## 0.1.1

GitHub PR review integration + prior-run-aware reviewers (initial release on this branch).
