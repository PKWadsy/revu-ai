# Findings contract reviewer (example)

This is an example rule scoped to a specific feature contract. Use it as a template.

## Contract

The `report_finding` MCP tool is the **only** way reviewers communicate findings to the runner. Its schema is the public protocol — callers depend on:

- `severity` is one of: `aesthetic`, `low`, `medium`, `high`, `critical`
- `path` is repo-relative, forward-slash separated
- `line` and `lineEnd` are 1-indexed and optional; if `lineEnd` is set, `line` must also be set
- `message` is non-empty
- `category` is optional free-form text

## What to flag

- Any change that broadens, narrows, renames, or removes a field on the `Finding` type without updating the corresponding Zod schema in `src/mcp/tools.ts`
- Any change to the Zod schema without updating the `Finding` TypeScript type in `src/types.ts`
- New severity levels that don't appear in `SEVERITY_ORDER`

## Severity

- `critical` for any breaking change to the schema (existing consumers will break)
- `high` for inconsistencies between the type and the schema
