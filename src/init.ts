import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { findRepoRoot } from "./refs.js";
import { getScaffoldHarness } from "./providers/registry.js";
import type { ReviewActivity } from "./providers/types.js";

export interface InitOptions {
  cwd: string;
  /** Overwrite existing rule files. */
  force: boolean;
  harness: string;
  /** AI provider id, only meaningful for harnesses that support multiple (e.g. opencode). */
  provider?: string;
  model?: string;
  timeoutMs: number;
  onActivity?: (activity: ReviewActivity) => void;
  onFileWritten?: (relPath: string) => void;
  onStart?: (info: { repoRoot: string }) => void;
}

export interface InitResult {
  ok: boolean;
  repoRoot: string;
  filesWritten: string[];
  durationMs: number;
  errorMessage?: string;
  timedOut?: boolean;
}

export class InitRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InitRefusedError";
  }
}

export async function runInit(opts: InitOptions): Promise<InitResult> {
  const repoRoot = findRepoRoot(opts.cwd);

  if (!opts.force) {
    const existing = listExistingGlobalRules(repoRoot);
    if (existing.length > 0) {
      throw new InitRefusedError(
        `revu-ai init: \`.revu/\` already contains rule files (${existing.join(", ")}). Pass --force to overwrite.`,
      );
    }
  }

  opts.onStart?.({ repoRoot });

  const factory = getScaffoldHarness(opts.harness);
  const agent = factory({
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.provider ? { provider: opts.provider } : {}),
  });

  const result = await agent.run({
    repoRoot,
    force: opts.force,
    timeoutMs: opts.timeoutMs,
    ...(opts.onActivity ? { onActivity: opts.onActivity } : {}),
    ...(opts.onFileWritten ? { onFileWritten: opts.onFileWritten } : {}),
  });

  return {
    ok: result.ok,
    repoRoot,
    filesWritten: result.filesWritten,
    durationMs: result.durationMs,
    ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
    ...(result.timedOut ? { timedOut: true } : {}),
  };
}

/** Returns the *.revu.md filenames already present in `<repoRoot>/.revu/`, or []. */
function listExistingGlobalRules(repoRoot: string): string[] {
  const dir = resolve(repoRoot, ".revu");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((n) => n.endsWith(".revu.md")).map((n) => join(".revu", n));
  } catch {
    return [];
  }
}
