# Severity sync reviewer

The `Severity` type is the canonical source (`src/types.ts`), but the set of valid severity levels is duplicated in several places that must stay in sync:
- `src/types.ts`: union type and `SEVERITY_ORDER` record
- `src/mcp/tools.ts`: Zod enum in `ReportFindingShape.severity`
- `src/mcp/aggregator.ts`: hardcoded `order` array in `maxSeverity()`
- `src/config.ts`: `SEVERITIES` set for CLI validation

A mismatch causes silent runtime failures — agents can report findings the aggregator doesn't recognize, or the CLI can accept a `--fail-on` value that breaks threshold logic.

## What to flag

- Any diff that adds, removes, or reorders a severity level in one location without updating all others.
- Any diff that introduces a new file with a hardcoded list of severities that differs from the canonical set.

## What to ignore

- Changes that update all four locations consistently in the same PR.
- Test files that import `Severity` from `src/types.ts` and use it correctly.
- Documentation or comments that mention severity names.

## Severity

- `high` for any inconsistency between the canonical `Severity` type and the duplicates.
- `medium` for introducing a new hardcoded severity list elsewhere that should instead import from `src/types.ts`.
