# Test coverage reviewer

The project uses Vitest with tests under `tests/`. Core logic (runner orchestration, safe-bash validation, MCP roundtrip, discovery, refs) has test coverage. New behavior should be tested.

## What to flag

- A new exported function in `src/` that has no corresponding test.
- A new code path in `isReadOnlyShellCommand` (safe-bash) without a test case in `tests/safe-bash.test.ts`.
- Changes to `src/runner.ts` orchestration logic without tests in `tests/runner.test.ts`.
- New MCP tool behavior without a test in `tests/mcp-roundtrip.test.ts`.
- Bug fixes that don't include a regression test.

## What to ignore

- Internal helper functions that are covered transitively by higher-level tests.
- Trivial one-liner changes to existing tested code.
- Changes to CLI output formatting that are cosmetic.
- Test-only changes.

## Severity

- `high` for security-sensitive code (safe-bash, auth token handling) without tests.
- `medium` for new user-facing behavior without tests.
- `low` for minor internal helpers.
