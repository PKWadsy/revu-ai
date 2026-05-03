# Safe bash allowlist reviewer

The `isReadOnlyShellCommand` function in `src/providers/claude-code.ts` gates what shell commands review and scaffold agents can execute. Its allowlists (`SAFE_LEADING_BINS`, `FORBIDDEN_GIT_SUBCOMMANDS`) are a critical security boundary — a bypass could let an agent run arbitrary code in user repos.

## What to flag

- Any change to `SAFE_LEADING_BINS` that adds a binary capable of writing files, executing code, or making network requests (e.g. `node`, `python`, `curl`, `wget`, `npm`, `pnpm`, `bun`, `sh`, `bash`, `zsh`, `eval`).
- Any change to `FORBIDDEN_GIT_SUBCOMMANDS` that removes a write-capable git operation.
- Any change to the regex logic in `isReadOnlyShellCommand` that could allow shell metacharacters (`>`, `<`, `&&`, `||`, `;`, `&`, backticks, `$(...)`) to slip through.
- A new code path that bypasses `isReadOnlyShellCommand` when invoking `Bash` from an agent.

## What to ignore

- Adding truly read-only binaries to `SAFE_LEADING_BINS` (e.g. `less`, `more`, `diff`, `comm`, `jq`, `yq`).
- Adding write-capable git subcommands to `FORBIDDEN_GIT_SUBCOMMANDS`.
- Test cases in `tests/safe-bash.test.ts` that exercise the allowlist.

## Severity

- `critical` for any change that would allow agents to write files, execute arbitrary code, or exfiltrate data.
- `high` for weakening the allowlist in a way that might open an indirect attack vector.
- `medium` for adding a safe binary without a corresponding test case.
