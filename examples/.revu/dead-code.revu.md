# Dead code reviewer

Review the changes for any **newly introduced dead code**: exports, functions, variables, types, or files that nothing references.

## What to flag

- A new `export` that is not imported anywhere in the repo
- A function declared but never called
- An imported symbol that becomes unused after the change
- A whole new file that is not referenced by any other file

## What to ignore

- Public API surface intentionally exposed for consumers (look for entries in `package.json` `exports` / `main` / `bin`, or `src/index.ts` re-exports)
- Test fixtures and helper files under `tests/`, `__tests__/`, or `*.test.*`
- Code paths gated by feature flags or env vars — assume they are reachable

## Severity guidance

- `low` for an unused private helper inside a single file
- `medium` for an unused exported symbol
- `high` for an entire new file with no inbound references
