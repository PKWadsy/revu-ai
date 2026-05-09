# Error handling reviewer

This codebase surfaces agent errors through `RuleResult.errorMessage` and `RunReport`. Silent catches or swallowed errors can make debugging impossible when agents fail.

## What to flag

- Empty `catch` blocks or `catch { }` with no logging, re-throw, or result assignment.
- Catching an error and returning a success status (`ok: true`) without propagating the error.
- Using `try/catch` around async operations without handling the rejection.
- Swallowing errors in event listeners or callbacks without at least logging them.

## What to ignore

- Intentional error suppression with an explanatory comment (e.g. `// listener errors must not affect aggregation`).
- `tryGit()` style wrappers that are explicitly designed to return `undefined` on failure.
- Test code that deliberately exercises error paths.

## Severity

- `high` for swallowing errors that would hide agent failures from the user.
- `medium` for empty catches in non-critical paths that could still cause confusion.
- `low` for minor suppressions in edge-case handlers with clear intent.
