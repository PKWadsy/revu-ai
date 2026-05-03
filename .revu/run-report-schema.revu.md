# RunReport schema reviewer

The JSON output of `revu-ai` is a stable contract for downstream tooling (CI integrations, custom reporters, dashboards). The schema is:
- Defined in `src/types.ts` as `RunReport`
- Documented in `README.md` under "Output"
- Consumed by `src/output/json.ts`, `src/output/pretty.ts`, `src/output/github.ts`

Changing the shape without updating the docs or bumping `schemaVersion` breaks consumers silently.

## What to flag

- Any change to `RunReport`, `Finding`, `RuleResult`, or `ResolvedTarget` types in `src/types.ts` that alters the JSON structure.
- Any change to how `src/runner.ts` constructs the `report` object that doesn't match the type.
- Any structural change without a corresponding `schemaVersion` bump.
- Any change to `README.md`'s "Output" JSON example that doesn't match the actual type.

## What to ignore

- Adding optional fields with `?` that don't affect existing consumers.
- Internal implementation changes in output emitters that don't alter the JSON shape.
- Test fixtures that use partial/mock reports.

## Severity

- `high` for any breaking change to the JSON schema without a `schemaVersion` bump.
- `medium` for a schema change that updates `schemaVersion` but doesn't update `README.md`.
- `low` for adding optional fields without documenting them.
