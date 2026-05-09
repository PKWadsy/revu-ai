# Public exports reviewer

`src/index.ts` is the public API surface for the `revu-ai` npm package. It re-exports functions and types from internal modules. The `package.json` declares `main`, `types`, and `exports` pointing at `dist/index.js`.

Changes to internal modules that aren't reflected in `src/index.ts` can accidentally break consumers who import from `revu-ai`.

## What to flag

- Removing an export from `src/index.ts` that was previously public.
- Renaming or changing the signature of an exported function/type without updating `src/index.ts`.
- A new public-facing function or type in an internal module that should be exported but isn't added to `src/index.ts`.
- Changes to `package.json` `exports` field that don't match `src/index.ts`.

## What to ignore

- Adding new exports to `src/index.ts` alongside the implementation.
- Internal helper functions in modules that aren't intended for public use.
- Test utilities and fixtures.

## Severity

- `high` for removing or breaking an existing public export.
- `medium` for adding a clearly-public function without exporting it.
- `low` for minor signature changes to internal helpers that happen to be re-exported.
