# Changelog

All notable changes to `revu-ai` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project's pre-1.0 versioning treats minor bumps as breaking-change boundaries.

## 0.6.0

### Added

- **Grok Build harness (`--harness grok-build`).** First-class support for
  [Grok Build](https://x.ai/cli) driven by Grok 4.5. Each rule gets an isolated
  `GROK_HOME` with a temp `config.toml` that wires the revu MCP sidecar
  (auth + `X-Revu-Rule-Id` headers), disables host Claude/Cursor MCP pickup,
  and — when you pass a raw API model id like `grok-4.5` — registers that id
  so CLI catalog lag can't reject it. Default model is `grok-build` (Grok 4.5).
  ```bash
  revu-ai --harness grok-build
  revu-ai --harness grok-build --model grok-4.5
  revu-ai init --harness grok-build
  ```
  Requires the `grok` binary on `PATH` (`curl -fsSL https://x.ai/cli/install.sh | bash`
  or `npm i -g @xai-official/grok`) and `XAI_API_KEY`.
- Reviews run headlessly with `--permission-mode dontAsk`, `--sandbox read-only`,
  `--no-subagents`, and `--disable-web-search`. Edit/Write/WebFetch/Task are
  denied; bash is limited to read-only patterns; MCP tools are allowlisted to
  `revu__*`. System prompts rewrite Claude-style `mcp__revu__*` tool names to
  Grok Build's `revu__*` namespace. Scaffold (`init`) routes writes through
  `revu__write_rule_file`.

### Changed

- Dogfood GitHub Action (`.github/workflows/revu-ai.yml`) now uses
  `--harness grok-build --model grok-build` and installs `@xai-official/grok`
  instead of opencode + `grok-4-1-fast-non-reasoning`.

## 0.5.0

### Fixed

- **Reviews stop "failing forever" after a fix — and now prove they re-checked every prior
  finding.** Previously a prior finding only cleared if the reviewer agent happened to call
  `mark_finding_resolved`, and a still-open finding was signalled by staying silent. Fast /
  non-reasoning models routinely did neither reliably: fixed findings kept their PR comments
  open and the next run was re-primed with the stale finding, so the review never went green
  even after the issue was fixed. Prior-finding handling is now **explicit and enforced**:
  for every prior finding the agent must take exactly one accounting action, and a review
  that leaves any prior finding untouched **fails** as incomplete (so a coding agent can't
  merge past findings the reviewer never re-examined).

### Added

- **`mark_finding_open` MCP tool.** The agent calls it to confirm a prior finding is still
  open at the same location — the explicit counterpart to `mark_finding_resolved`. Confirmed-
  open findings keep their existing PR comment (no duplicate is posted) and are re-injected
  into the run report, so the exit code and carried-forward cache reflect that the issue
  persists. A still-open finding that *moved* is re-reported via `report_finding` with
  `priorFp` set, exactly as before.
- **Prior-finding accounting enforcement in the runner.** After a rule's agent runs cleanly,
  the runner checks that every prior finding it was given was accounted for — confirmed open
  (`mark_finding_open` / `report_finding` with `priorFp`) or resolved (`mark_finding_resolved`).
  Any unaccounted prior fails the rule with an explicit error naming the fingerprints, which
  forces a non-zero exit. Rules that error, time out, are gated, or are skipped are exempt
  (they didn't run a review to hold to the contract).

### Changed

- The prior-findings system prompt is rewritten to state the requirement loudly: every prior
  finding must be explicitly marked still-open or resolved, and silence now fails the review
  rather than being interpreted as "fixed". `mark_finding_resolved`'s description was updated
  to frame it as one of the two required accounting actions.

## 0.4.2

### Added

- **System prompt now states rule-file precedence explicitly.** Operators occasionally
  need a rule to override a system-prompt default (e.g. broaden scope past the diff for a
  full-repo audit). A new "Precedence" section at the top of the prompt tells the agent
  that when the rule file contradicts the system prompt, the rule file wins. System-prompt
  defaults apply only where the rule is silent.

### Fixed

- **Findings must be caused by or required by the diff, not pre-existing issues elsewhere
  in the repo.** Without an explicit scope constraint, agents would walk the broader
  codebase via `Read`/`Grep` looking for instances of a rule's anti-pattern and file
  findings against files the PR never touched — turning every enforcement of a
  sufficiently-general rule (e.g. "no direct REST in components") into a review of the
  whole repo. The new constraint allows findings on out-of-diff files when the diff
  caused or invalidated them (a signature change that breaks an out-of-diff caller, a
  contract the diff broke for pre-existing code, etc.), but pre-existing unrelated code
  is out of scope. The test agents are given: "would this finding still apply if the diff
  were reverted?". Out-of-diff `Read`/`Grep` for verification continues to be allowed.
  Rule files may broaden this scope explicitly under the new precedence rule.

## 0.4.1

### Fixed

- **Gated rules are no longer reported as clean or incomplete.** When a stage tripped the
  gate, the later (`gated`) rules were rendered as `✓ clean` in the live progress and
  falsely flagged by the "did not call `report_review_summary` — likely incomplete review"
  warning, even though they never ran. The pretty output now shows a dedicated
  `⏭ N rule(s) did not run — an earlier stage tripped the gate` banner, the
  incomplete-review and possibly-silenced detectors skip `gated` rules, and the live
  per-rule status prints `⏭ skipped (gated)`. Pre-flight file-filtered rules likewise now
  print `⏭ skipped (no matching files)` instead of `✓ clean`.

## 0.4.0

### Added

- **Staged, fail-fast review.** Rule files may declare a `stage:` integer in their YAML
  frontmatter. Rules sharing a stage run in parallel; stages run in ascending order. After
  each stage, if any accumulated finding is at/above the gate threshold, later stages are
  skipped (marked `gated` in the report) and spawn no agents.
- `--gate-on <severity>` controls the gate; it falls back to `--fail-on` when omitted.
  `--fail-on` still sets the exit code; `--gate-on` only controls whether later stages run.

### Notes

- Backwards compatible: a rule set with no `stage:` declarations runs as a single stage,
  identical to prior behavior. Reports remain `schemaVersion: 3` (`gated` is an additive
  optional field; the `github post` step tolerates it).

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
