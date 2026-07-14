# AGENTS.md

## Cursor Cloud specific instructions

`revu-ai` is a **CLI + library** for parallel AI code review (Node.js ≥ 20, TypeScript, ESM). There is **no web frontend, no backend service, and no database** — nothing long-running to start. Development is: install deps, then run `typecheck` / `test` / `build` and the CLI.

### Toolchain
- Package manager is **pnpm** (declared via `packageManager` in `package.json`). A `package-lock.json` also exists but pnpm is authoritative — prefer pnpm.
- Standard commands live in `package.json` `scripts`: `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm dev` (runs `tsx src/cli.ts`). CI (`.github/workflows/ci.yml`) runs typecheck → test → build.

### Non-obvious caveats
- On `pnpm install` you'll see a warning that **esbuild build scripts were ignored**. This is harmless: `tsx` and `vitest` both work regardless, so do **not** run the interactive `pnpm approve-builds`.
- The test suite is slow (~60s): `tests/refs.test.ts` and `tests/runner.test.ts` spend ~30s each because they auto-detect `origin/main` and drive real git operations. This is expected, not a hang.
- **A real end-to-end AI review requires an AI provider API key** (`ANTHROPIC_API_KEY` for the default `claude-code` harness; `XAI_API_KEY` for the `grok` harness; `XAI_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` / `OPENAI_API_KEY` for the `opencode` harness, which also needs the `opencode` binary on `PATH`). Without a key, `revu-ai` (the `run` command) cannot spawn review agents.
- **Grok Build harness (`--harness grok`, in `src/providers/grok.ts`)**: drives xAI's `grok` CLI in headless mode (`grok -p … --output-format streaming-json`, default model `grok-4.5`). It is NOT an npm dependency — install the binary once with `curl -fsSL https://x.ai/cli/install.sh | bash` (lands in `~/.grok/bin`; add that to `PATH`). Auth via `XAI_API_KEY` or a cached `grok login`. Each rule runs in an isolated `$HOME` with a generated `~/.grok/config.toml` that registers the revu MCP sidecar; findings flow through MCP (stdout `streaming-json` parsing only drives progress/diagnostics). You can validate the MCP wiring without a key by starting a sidecar and running `grok mcp doctor revu --json` against a generated config (note: use async `spawn`, never `spawnSync`, since the sidecar shares the event loop).
- The **core review pipeline can be exercised offline** without any API key:
  - `pnpm dev list` — discover `*.revu.md` rule files.
  - `pnpm exec tsx scripts/smoke-mcp.ts` — starts the in-process MCP sidecar, connects an MCP client, calls `report_finding`, verifies dedup + aggregation.
- The MCP sidecar is started/stopped automatically per run and binds a **random localhost port** with a bearer auth token; it is not a service you start manually.
