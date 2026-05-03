#!/usr/bin/env node
import { createRequire } from "node:module";
import { Command } from "commander";
import { findRepoRoot } from "./refs.js";

const pkg = createRequire(import.meta.url)("../package.json") as { name: string; version: string };
import { loadConfig, type CliOverrides } from "./config.js";
import { listRules, run, RevuExit } from "./runner.js";
import { emitJson } from "./output/json.js";
import { emitPretty } from "./output/pretty.js";
import { emitGithub } from "./output/github.js";
import type { Severity } from "./types.js";

const COLOR = process.stderr.isTTY && !process.env.NO_COLOR;
const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};
type Color = keyof typeof c;
const paint = (color: Color, s: string): string => (COLOR ? `${c[color]}${s}${c.reset}` : s);
const SEV_COLOR: Record<Severity, Color> = {
  aesthetic: "gray",
  low: "blue",
  medium: "yellow",
  high: "red",
  critical: "magenta",
};
const SEV_LABEL: Record<Severity, string> = {
  aesthetic: "nit ",
  low: "low ",
  medium: "med ",
  high: "high",
  critical: "CRIT",
};

const program = new Command();

program
  .name(pkg.name)
  .description("Parallel AI code review with per-rule Claude agents")
  .version(pkg.version);

program
  .command("list")
  .description("List rule files that would be reviewed")
  .option("--pattern <glob>", "rule file glob")
  .option("--config <path>", "config file path")
  .action(async (opts: { pattern?: string; config?: string }) => {
    const cwd = process.cwd();
    const repoRoot = findRepoRoot(cwd);
    const cfg = loadConfig(repoRoot, { pattern: opts.pattern, config: opts.config });
    const rules = await listRules(cwd, cfg.pattern);
    if (rules.length === 0) {
      console.log(`No rule files found matching ${cfg.pattern}`);
      return;
    }
    for (const r of rules) {
      console.log(`${r.ruleId}\t${r.relPath}`);
    }
  });

program
  .command("init")
  .description("Spawn an agent to inspect the repo and scaffold curated .revu.md rule files")
  .option("--force", "overwrite existing rule files in .revu/")
  .option("--provider <name>", "scaffold provider (default: claude-code)")
  .option("--model <id>", "model id passed to provider")
  .option("--timeout-ms <ms>", "scaffold agent wall-clock timeout (default: 600000 = 10min)", parseIntOpt)
  .action(async (opts: { force?: boolean; provider?: string; model?: string; timeoutMs?: number }) => {
    const { runInit, InitRefusedError } = await import("./init.js");
    const showProgress = process.stderr.isTTY && !process.env.REVU_DEBUG;
    try {
      const result = await runInit({
        cwd: process.cwd(),
        force: opts.force ?? false,
        provider: opts.provider ?? "claude-code",
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        timeoutMs: opts.timeoutMs ?? 600_000,
        onStart: ({ repoRoot }) =>
          process.stderr.write(`${paint("cyan", "▶")} ${paint("bold", "scaffolding rule files")} ${paint("dim", repoRoot)}\n`),
        onActivity: showProgress
          ? (a) => {
              if (a.kind === "tool" && a.name === "Write") {
                // Each Write gets its own "✱ created" line via onFileWritten — skip the dim activity.
                return;
              }
              if (a.kind === "tool") {
                process.stderr.write(`  ${paint("dim", "↳")} ${paint("cyan", a.name ?? "")}${paint("dim", `(${a.detail})`)}\n`);
              } else if (a.detail) {
                process.stderr.write(`  ${paint("dim", "…")} ${paint("dim", a.detail)}\n`);
              }
            }
          : undefined,
        onFileWritten: showProgress
          ? (rel) =>
              process.stderr.write(`  ${paint("bold", paint("green", "✱ created"))} ${paint("bold", rel)}\n`)
          : undefined,
      });

      if (!result.ok) {
        const label = result.timedOut ? "⏱ scaffold timed out" : "✗ scaffold failed";
        const color = result.timedOut ? "yellow" : "red";
        process.stderr.write(`${paint(color, paint("bold", label))} ${paint(color, result.errorMessage ?? "?")}\n`);
        if (result.filesWritten.length > 0) {
          process.stderr.write(`${paint("dim", `(${result.filesWritten.length} file(s) written before exit)`)}\n`);
          for (const f of result.filesWritten) process.stderr.write(`  ${paint("dim", f)}\n`);
        }
        process.exit(2);
      }

      const globals = result.filesWritten.filter((f) => f.startsWith(".revu/")).sort();
      const locals = result.filesWritten.filter((f) => !f.startsWith(".revu/")).sort();
      process.stderr.write(
        `${paint("bold", paint("green", "✓"))} ${paint("bold", String(result.filesWritten.length))} ${paint("dim", `rule file${result.filesWritten.length === 1 ? "" : "s"} created`)} ${paint("dim", `(${result.durationMs}ms)`)}\n`,
      );
      if (globals.length > 0) {
        process.stderr.write(`  ${paint("bold", "globals")}\n`);
        for (const f of globals) process.stderr.write(`    ${f}\n`);
      }
      if (locals.length > 0) {
        process.stderr.write(`  ${paint("bold", "locals")}\n`);
        for (const f of locals) process.stderr.write(`    ${f}\n`);
      }
      process.exit(0);
    } catch (e) {
      if (e instanceof InitRefusedError) {
        process.stderr.write(`${paint("yellow", paint("bold", "revu-ai init:"))} ${e.message.replace(/^revu-ai init: /, "")}\n`);
        process.exit(1);
      }
      process.stderr.write(`${paint("red", paint("bold", "revu-ai init:"))} ${(e as Error).message}\n`);
      process.exit(2);
    }
  });

program
  .command("run", { isDefault: true })
  .description("Run a review")
  .option("--base <ref>", "review base ref (default: auto-detect main)")
  .option("--working-tree", "review uncommitted working-tree changes")
  .option("--staged", "review staged changes only")
  .option("--pattern <glob>", "rule file glob")
  .option("--provider <name>", "review provider (default: claude-code)")
  .option("--model <id>", "model id passed to provider")
  .option("--concurrency <n>", "max parallel agents", parseIntOpt)
  .option("--output <fmt>", "pretty | json | github")
  .option("--output-file <path>", "additionally write output to a file")
  .option("--fail-on <severity>", "exit non-zero threshold (default: high)")
  .option("--timeout-ms <ms>", "per-rule wall-clock timeout in ms (default: 300000 = 5min); 0 disables", parseIntOpt0Allowed)
  .option("--force", "ignore the no-changes pre-flight skip")
  .option("--config <path>", "config file path")
  .action(async (opts: CliOverrides) => {
    const cwd = process.cwd();
    const repoRoot = findRepoRoot(cwd);
    const cfg = loadConfig(repoRoot, opts);
    try {
      const showProgress = process.stderr.isTTY && !process.env.REVU_DEBUG;
      const { report, exitCode } = await run(cwd, cfg, {
        onRuleStart: (id) =>
          process.stderr.write(`${paint("cyan", "▶")} ${paint("bold", id)}\n`),
        onActivity: showProgress
          ? (id, a) => {
              if (a.kind === "tool" && a.name === "mcp__revu__report_finding") {
                // Findings get their own line via onFinding — skip the tool-use noise.
                return;
              }
              if (a.kind === "tool") {
                process.stderr.write(
                  `  ${paint("dim", id)} ${paint("dim", "↳")} ${paint("cyan", a.name ?? "")}${paint("dim", `(${a.detail})`)}\n`,
                );
              } else if (a.detail) {
                process.stderr.write(
                  `  ${paint("dim", id)} ${paint("dim", "…")} ${paint("dim", a.detail)}\n`,
                );
              }
            }
          : undefined,
        onFinding: showProgress
          ? (f) => {
              const loc = f.line !== undefined ? `:${f.line}` : "";
              const sev = paint(SEV_COLOR[f.severity], SEV_LABEL[f.severity]);
              process.stderr.write(
                `  ${paint("dim", f.ruleId)} ${paint("bold", paint(SEV_COLOR[f.severity], "✱"))} ${sev} ${paint("bold", f.path)}${paint("dim", loc)}\n`,
              );
            }
          : undefined,
        onRuleEnd: (r) => {
          const dur = paint("dim", `(${r.durationMs}ms)`);
          let status: string;
          if (r.timedOut) {
            const count = r.findingCount > 0 ? ` ${r.findingCount} partial finding(s)` : "";
            status = `${paint("yellow", "⏱ timed out")}${paint("dim", count)}`;
          } else if (!r.ok) {
            status = `${paint("red", "✗ error:")} ${paint("red", r.errorMessage ?? "?")}`;
          } else if (r.findingCount === 0) {
            status = paint("green", "✓ clean");
          } else {
            status = `${paint("green", "✓")} ${paint("bold", String(r.findingCount))} ${paint("dim", `finding${r.findingCount === 1 ? "" : "s"}`)}`;
          }
          process.stderr.write(`  ${paint("bold", r.id)} ${status} ${dur}\n`);
        },
      });

      const fmt = cfg.output === "auto" ? (process.stdout.isTTY ? "pretty" : "json") : cfg.output;
      const outFile = cfg.outputFile;
      if (fmt === "json") emitJson(report, outFile);
      else if (fmt === "github") emitGithub(report, outFile);
      else emitPretty(report, outFile);

      // If every rule errored, emit a stderr line with the actual cause so
      // it's visible even when stdout is being piped/captured.
      const failed = report.rules.filter((r) => !r.ok);
      if (failed.length === report.rules.length && failed.length > 0) {
        const messages = new Set(failed.map((r) => r.errorMessage ?? "unknown"));
        const prefix = paint("red", paint("bold", "revu-ai:"));
        if (messages.size === 1) {
          process.stderr.write(
            `${prefix} all ${failed.length} rule agents failed: ${paint("red", String([...messages][0]))}\n`,
          );
        } else {
          process.stderr.write(
            `${prefix} all ${failed.length} rule agents failed ${paint("dim", "(mixed errors; see report)")}\n`,
          );
        }
      }
      const timedOut = report.rules.filter((r) => r.timedOut);
      if (timedOut.length > 0) {
        process.stderr.write(
          `${paint("yellow", paint("bold", "revu-ai:"))} ${timedOut.length} rule(s) timed out — partial findings included in the report\n`,
        );
      }

      process.exit(exitCode);
    } catch (e) {
      if (e instanceof RevuExit) {
        if (e.exitCode === 0) console.log(e.message);
        else console.error(e.message);
        process.exit(e.exitCode);
      }
      console.error((e as Error).stack ?? String(e));
      process.exit(2);
    }
  });

function parseIntOpt(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid integer: ${value}`);
  return n;
}

function parseIntOpt0Allowed(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid integer: ${value}`);
  return n;
}

program.parseAsync(process.argv).catch((e) => {
  console.error((e as Error).stack ?? String(e));
  process.exit(2);
});
