import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findRepoRoot } from "./refs.js";

const STARTERS = [
  "dead-code.revu.md",
  "contract-example.revu.md",
] as const;

const DEFAULT_REVU_CONFIG = {
  pattern: "**/*.revu.md",
  provider: "claude-code",
  failOn: "high",
  output: "auto",
};

export interface InitOptions {
  cwd: string;
  dir: string;
  force?: boolean;
}

export interface InitResult {
  created: string[];
  skipped: string[];
}

export function runInit(opts: InitOptions): InitResult {
  const repoRoot = findRepoRoot(opts.cwd);
  const targetDir = resolve(repoRoot, opts.dir);
  const created: string[] = [];
  const skipped: string[] = [];

  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });

  const examplesDir = locateExamplesDir();

  for (const filename of STARTERS) {
    const dest = join(targetDir, filename);
    if (existsSync(dest) && !opts.force) {
      skipped.push(relative(repoRoot, dest));
      continue;
    }
    const src = join(examplesDir, filename);
    writeFileSync(dest, readFileSync(src, "utf8"), "utf8");
    created.push(relative(repoRoot, dest));
  }

  const configPath = resolve(repoRoot, "revu.config.json");
  if (existsSync(configPath) && !opts.force) {
    skipped.push(relative(repoRoot, configPath));
  } else {
    writeFileSync(configPath, JSON.stringify(DEFAULT_REVU_CONFIG, null, 2) + "\n", "utf8");
    created.push(relative(repoRoot, configPath));
  }

  return { created, skipped };
}

function locateExamplesDir(): string {
  // Resolve relative to this compiled module: dist/init.js → ../examples/.revu (when packaged)
  // and src/init.ts → ../examples/.revu (when run via tsx).
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "..", "examples", ".revu"),       // dist/ or src/ → ../examples/.revu
    resolve(here, "..", "..", "examples", ".revu"), // safety net
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error("revu init: could not locate bundled example rule files");
}
