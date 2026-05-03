# Severity display sync reviewer

The severity-to-color and severity-to-label mappings are duplicated in two places:
- `src/cli.ts`: `SEV_COLOR` and `SEV_LABEL`
- `src/output/pretty.ts`: `SEV_COLOR` and `SEV_LABEL`

These must stay identical so terminal output during the run matches the final pretty-printed report.

## What to flag

- Any change to `SEV_COLOR` or `SEV_LABEL` in one file without the same change in the other.
- Adding a new severity display (emoji, badge, etc.) in one output path but not the other.

## What to ignore

- Changes that update both files consistently in the same PR.
- Structural changes that consolidate these mappings into a shared module.

## Severity

- `medium` for inconsistent severity display between run-time progress and final output.
- `low` for minor formatting differences that don't affect clarity.
