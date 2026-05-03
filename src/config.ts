import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { RevuConfig, Severity } from "./types.js";

const SEVERITIES: ReadonlySet<Severity> = new Set([
  "aesthetic",
  "low",
  "medium",
  "high",
  "critical",
]);

export const DEFAULT_CONFIG: RevuConfig = {
  pattern: "**/*.revu.md",
  workingTree: false,
  staged: false,
  provider: "claude-code",
  output: "auto",
  failOn: "high",
  force: false,
  timeoutMs: 300_000,
};

export interface CliOverrides {
  base?: string;
  workingTree?: boolean;
  staged?: boolean;
  pattern?: string;
  provider?: string;
  model?: string;
  concurrency?: number;
  output?: "pretty" | "json" | "github";
  outputFile?: string;
  failOn?: string;
  force?: boolean;
  config?: string;
  timeoutMs?: number;
  priorReport?: string;
}

export function loadConfig(repoRoot: string, overrides: CliOverrides): RevuConfig {
  const file = overrides.config
    ? resolve(repoRoot, overrides.config)
    : resolve(repoRoot, "revu.config.json");

  let fromFile: Partial<RevuConfig> = {};
  if (existsSync(file)) {
    try {
      fromFile = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      throw new Error(`Failed to parse ${file}: ${(e as Error).message}`);
    }
  }

  const merged: RevuConfig = {
    ...DEFAULT_CONFIG,
    ...fromFile,
  };

  if (overrides.pattern !== undefined) merged.pattern = overrides.pattern;
  if (overrides.base !== undefined) merged.base = overrides.base;
  if (overrides.workingTree !== undefined) merged.workingTree = overrides.workingTree;
  if (overrides.staged !== undefined) merged.staged = overrides.staged;
  if (overrides.provider !== undefined) merged.provider = overrides.provider;
  if (overrides.model !== undefined) merged.model = overrides.model;
  if (overrides.concurrency !== undefined) merged.concurrency = overrides.concurrency;
  if (overrides.output !== undefined) merged.output = overrides.output;
  if (overrides.outputFile !== undefined) merged.outputFile = overrides.outputFile;
  if (overrides.force !== undefined) merged.force = overrides.force;
  if (overrides.timeoutMs !== undefined) merged.timeoutMs = overrides.timeoutMs;
  if (overrides.priorReport !== undefined) merged.priorReport = overrides.priorReport;
  if (overrides.failOn !== undefined) {
    if (!SEVERITIES.has(overrides.failOn as Severity)) {
      throw new Error(
        `Invalid --fail-on value: ${overrides.failOn}. Expected one of: ${[...SEVERITIES].join(", ")}`,
      );
    }
    merged.failOn = overrides.failOn as Severity;
  }

  if (merged.workingTree && merged.staged) {
    throw new Error("--working-tree and --staged are mutually exclusive");
  }

  return merged;
}
