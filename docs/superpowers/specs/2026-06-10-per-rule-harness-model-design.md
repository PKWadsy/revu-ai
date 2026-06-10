# Per-rule harness / model / provider in frontmatter

**Status:** approved
**Date:** 2026-06-10

## Problem

Today the agent harness, provider, and model are run-global: set once via
`revu.config.json` or CLI flags, and every rule's reviewer agent runs on the same
harness/model. A reviewer can't say "this rule is cheap pattern-matching, run it on
a fast model" or "this rule needs deep reasoning, run it on Opus" or "review this
service's rules through Gemini." The runner builds a single provider instance up
front (`runner.ts:102-106`) and reuses it for every rule.

## Goal

Let each `*.revu.md` rule file choose its own `harness`, `model`, and `provider`
via YAML frontmatter, overriding the run-global config for that rule only.

## Core rule: atomic override group

The three keys `harness` / `model` / `provider` form **one atomic group**:

- If a rule file's frontmatter contains **none** of them → the rule inherits the
  global config/CLI agent settings exactly as today (no behavior change).
- If it contains **any** of them → that rule's agent config is built **entirely**
  from frontmatter. Global config/CLI `harness`/`model`/`provider` are never
  consulted for this rule. There is no field-by-field merge.

This eliminates cross-harness contamination (a global `model: grok-4` can never
leak into a rule that flips to `claude-code`) without any special-case guard.

### Validation (when overriding)

| Harness          | `harness` | `model` | `provider`            |
| ---------------- | --------- | ------- | --------------------- |
| any              | required  | required | —                    |
| `opencode`       | required  | required | **required**          |
| `claude-code`    | required  | required | optional (ignored)    |
| custom/other     | required  | required | optional              |

Concretely, a rule that overrides fails loudly (`ok: false`, contributes exit
code 2) when:

- `model:` (or `provider:`) is present but `harness:` is absent — incomplete group.
- `harness:` is present but `model:` is absent — incomplete group.
- `harness: opencode` is present but `provider:` is absent — opencode needs a provider.
- Any of the three is present but **empty** (bare `harness:`) — mirrors how empty
  `files:` already fails rather than silently meaning nothing.

Failures are isolated to the offending rule; the rest of the run proceeds.

### Examples

```markdown
---
files: "src/api/**/*.py"
harness: opencode
provider: google
model: gemini-2.5-pro
---
# Python API contract enforcement
```
✅ valid — full opencode triple.

```markdown
---
harness: claude-code
model: claude-opus-4-8
---
# Deep architectural review
```
✅ valid — claude-code needs no provider.

```markdown
---
model: gemini-2.5-pro
---
```
❌ fails — `model` set without `harness`; incomplete override group.

## Components

### 1. Frontmatter parsing — `src/discovery.ts`

Add a `parseFrontmatterScalar(frontmatter, key)` helper returning
`string | undefined | EMPTY`, parsing a single quoted-or-unquoted scalar the same
way the existing `files:` single-value shorthand does. Distinguish "key absent"
(`undefined`) from "key present but empty" so the runner can fail the latter.

`parseFrontmatter` returns the three new optional fields alongside `content`,
`filePatterns`, and `stage`. Parsing itself does **not** enforce the atomic-group
validation — it only extracts values and flags empties. Validation lives in the
runner (so it can be surfaced as a per-rule failure result rather than a thrown
parse error that aborts discovery). Exception: an empty scalar is represented
distinctly so the runner knows to fail it.

> Decision: keep group/cross-key validation in the runner, not the parser, so a
> bad override degrades to a single failed `RuleResult` (consistent with how an
> empty `files:` list and an invalid glob are handled in `executeRule`) instead
> of throwing from `discoverRules` and killing the whole run. A malformed
> `stage:` still throws from the parser (unchanged) because stage drives
> run-global ordering; agent-config keys are per-rule and isolatable.

### 2. Types — `src/types.ts`

Add to `RuleFile`:

```ts
/** Per-rule agent harness override (frontmatter `harness:`). Part of the atomic
 *  {harness, model, provider} override group — see design doc. */
harness?: string;
/** Per-rule model override (frontmatter `model:`). */
model?: string;
/** Per-rule provider override (frontmatter `provider:`). */
provider?: string;
```

### 3. Per-rule provider resolution + cache — `src/runner.ts`

Replace the single up-front provider (`runner.ts:102-106`) with per-rule resolution:

- A helper `resolveRuleAgent(rule, config)` that returns either
  `{ harness, model?, provider? }` (the resolved settings) or a validation error
  string. When the rule declares no override keys, it returns the global config's
  `{ harness, model, provider }`. When it declares any, it validates the atomic
  group (per the table above) and returns the frontmatter-only settings, or an
  error string if incomplete/empty.
- A provider instance cache: `Map<string, ReviewAgent>` keyed by
  `` `${harness}\0${provider ?? ""}\0${model ?? ""}` ``. `executeRule` looks up /
  lazily creates the provider for its resolved settings. When no rule overrides
  anything, every rule resolves to the same key → one instance, identical to
  today.
- `getHarnessFactory(harness)` is called inside `executeRule` and wrapped: an
  unknown harness (global or per-rule) produces a failed `RuleResult` with the
  thrown message, rather than aborting the run. (Today an unknown global harness
  throws before any rule runs; this preserves loud failure but scopes per-rule
  overrides correctly.)
- Order within `executeRule`: **validate override → file-pattern skip check →
  resolve + instantiate provider → run**. Validation runs first so a broken
  override is always reported (even on a rule whose files wouldn't match),
  consistent with how the empty-`files:` failure is reported today. Provider
  *instantiation* is deferred until after the skip check, so a rule with nothing
  to review never spins up an agent.

### 4. Visibility — `list` command (`src/runner.ts` `listRules`, `src/cli.ts`)

`listRules` returns the per-rule override (if any) so `revu-ai list` can show it:

```
python-api  services/api/contract.revu.md  [opencode/google/gemini-2.5-pro]
dead-code   .revu/dead-code.revu.md
```

Format: `[harness/provider/model]`, omitting the provider segment when absent
(`[claude-code/claude-opus-4-8]`). No override → no bracket. This is
display-only; the JSON report schema is unchanged (kept additive-safe; out of
scope).

### 5. Out of scope (YAGNI)

- `init` / scaffold (a single global agent, not per-rule).
- Per-rule `concurrency` / `timeoutMs` / `failOn` / `gateOn`.
- JSON report schema changes (no new `schemaVersion`).

## Error handling

- Incomplete / empty override group → `RuleResult { ok: false, errorMessage }`,
  rule does not run, contributes exit code 2. Message names the missing/empty key.
- Unknown harness (global or per-rule) → failed `RuleResult` with the registry's
  "Unknown review harness" message.
- All per-rule failures are isolated: other rules in the stage still run.

## Testing

**Parsing (`tests/discovery.test.ts` or similar):**
- Each key parsed: quoted and unquoted scalar.
- All three absent → fields undefined (today's behavior).
- Empty scalar (bare `harness:`) flagged distinctly from absent.
- Coexists with `files:` and `stage:` in the same frontmatter block.

**Resolution + run (`tests/runner.test.ts` or similar):**
- No override → uses global config; single provider instance (cache reuse).
- Full opencode triple override → uses those settings; global config ignored.
- claude-code override without provider → valid.
- `model` without `harness` → rule fails, others proceed.
- `harness: opencode` without `provider` → rule fails.
- bare/empty key → rule fails.
- Unknown harness in frontmatter → that rule fails, run continues.
- Two rules with identical overrides → one shared provider instance.
- Invalid override on a rule whose files wouldn't match → still reported as failed.

## Docs

- README "Writing rule files" → new "Per-rule harness / model / provider"
  subsection with the atomic-group rule and the examples above.
- CHANGELOG entry under a new minor version (0.6.0).
- `package.json` version bump to 0.6.0.
