# revu

Parallel AI code review for any git repo. You drop Markdown rule files (`*.revu.md`) anywhere in your project; on each run, `revu` spawns a separate Claude agent **per rule file** in parallel. Each agent reviews the current diff *only through the lens of its assigned rules* and reports findings back through a sidecar MCP server. The aggregated findings come out as JSON, pretty terminal output, or GitHub Actions PR annotations.

The point: instead of one giant "be a good reviewer" prompt, you write narrow, scoped rule files (dead code, contract enforcement, dependency hygiene, naming conventions, etc.) and they run independently. Most rule agents will silently exit on any given diff because the changes don't touch their scope.

## Install

```bash
pnpm add -g revu
# or:
npx revu init
```

Set `ANTHROPIC_API_KEY` in your environment.

## Quick start

```bash
cd my-project
revu init             # spawn an agent to inspect the repo and scaffold rule files
revu list             # show what would be reviewed
revu                  # run it
```

`revu init` spawns a Claude agent that inspects your repo (CLAUDE.md, README, manifests, lint configs, top-level structure) and writes a curated set of `.revu.md` files. Globals go in `.revu/<topic>.revu.md`; rules scoped to a sub-service go alongside it (e.g. `services/auth/openapi.revu.md`). The agent searches for *implicit contracts* first — places where two parts of the codebase must be kept in sync but the type system doesn't enforce it — because those are the highest-value rules.

The agent is opinionated: language-aware (uses your project's actual logger / docstring style / convention idioms), refuses to restate things your linter and type-checker already enforce, and writes one concern per file. Re-run with `--force` to overwrite. Calibrate the wall-clock cap with `--timeout-ms` (default 10min).

## Writing rule files

A rule file is a plain Markdown document that describes a narrow review concern. Anything you'd put in a focused PR-review prompt works. Keep them small and single-purpose.

```markdown
# Logging discipline

Flag any newly added log statement that:

- Logs PII (email, user IDs, auth tokens)
- Uses `console.log` instead of the project logger (`src/log.ts`)
- Lacks structured fields (we want `{ event, ... }`, not freeform strings)

## Severity

- `critical` for anything that logs auth tokens
- `high` for anything that logs PII
- `medium` for `console.log` instead of the project logger
```

The agent is told to only report findings that match the rule. If your diff has no logging changes, this rule will silently pass.

## How it works

```
revu CLI
  ├─ discover *.revu.md (respects .gitignore)
  ├─ resolve review target (default: origin/main...HEAD)
  ├─ start MCP sidecar on a random localhost port
  ├─ for each rule, in parallel:
  │     spawn Claude agent (Claude Agent SDK)
  │       ├─ system prompt = rule contents + reporting protocol
  │       ├─ user prompt = "review the changes between <base> and <head>"
  │       ├─ tools = Read, Grep, Glob, read-only Bash, mcp__revu__report_finding
  │       └─ runs `git diff` itself to inspect the changes
  └─ aggregate findings, emit output, exit
```

The runner doesn't pre-compute the diff and stuff it into the prompt — agents inspect the changes via their own `git diff` calls. This sidesteps token-budget and large-file problems that the agent already handles natively.

Bash is gated to read-only commands (`git diff/log/show/status`, `cat`, `head`, `tail`, `ls`, `find`, `wc`, etc.). Mutating git operations (`push`, `commit`, `checkout`, …) and shell metacharacters (`>`, `&&`, `;`, backticks) are rejected.

## CLI

```
revu [options]              # run a review (default command)
revu init [--dir .revu]     # scaffold starter rules + config
revu list                   # show discovered rule files

Options:
  --base <ref>              # diff base; default: auto-detected origin/main
  --working-tree            # review uncommitted changes instead of branch
  --staged                  # review staged changes only
  --pattern <glob>          # rule file glob; default: **/*.revu.md
  --provider <name>         # default: claude-code
  --model <id>              # passed to provider
  --concurrency <n>         # max parallel agents; default: min(8, ruleCount)
  --output <fmt>            # pretty | json | github (default: auto)
  --output-file <path>      # also write output to a file
  --fail-on <severity>      # exit-code threshold; default: high
  --force                   # skip the no-changes pre-flight short-circuit
  --config <path>           # config file; default: revu.config.json
```

Exit codes: `0` clean, `1` findings ≥ `--fail-on`, `2` runner / agent error.

## Configuration

`revu.config.json` mirrors the CLI flags (CLI wins on conflict):

```json
{
  "pattern": "**/*.revu.md",
  "provider": "claude-code",
  "model": "claude-sonnet-4-6",
  "concurrency": 8,
  "output": "auto",
  "failOn": "high"
}
```

## Output

The JSON shape is the stable contract for downstream tooling:

```json
{
  "schemaVersion": 1,
  "runId": "...",
  "startedAt": "...",
  "completedAt": "...",
  "reviewTarget": { "mode": "ref-range", "base": "origin/main", "baseSha": "...",
                    "head": "HEAD", "headSha": "...", "changedFiles": ["..."] },
  "rules": [{ "id": "dead-code", "path": ".revu/dead-code.revu.md",
              "ok": true, "durationMs": 12345, "findingCount": 1 }],
  "findings": [{ "ruleId": "dead-code", "severity": "high",
                 "path": "src/foo.ts", "line": 42, "lineEnd": 47,
                 "message": "...", "category": "unused-export" }]
}
```

## GitHub Actions

A starter workflow lives at `examples/github-workflow.yml`. Drop it into `.github/workflows/revu.yml` and add `ANTHROPIC_API_KEY` as a repo secret. With `--output github`, findings render as PR annotations.

## Custom providers

The default reviewer is Claude Code via `@anthropic-ai/claude-agent-sdk`. The `ReviewAgent` interface in `src/providers/types.ts` is the swap-out boundary:

```ts
import { registerProvider } from "revu";

registerProvider("my-provider", (cfg) => ({
  name: "my-provider",
  async run(input) {
    // Connect to input.mcp.url with Authorization: Bearer <input.mcp.authToken>
    // and X-Revu-Rule-Id: <input.ruleId>. Call mcp__report_finding for each finding.
    // Return { ruleId, ok, durationMs }.
  },
}));
```

Then `revu --provider my-provider` (or set it in `revu.config.json`).

## License

MIT.
