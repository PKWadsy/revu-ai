import { writeFileSync } from "node:fs";
import type { RunReport, Severity } from "../types.js";

const COLOR_ENABLED = process.stdout.isTTY && !process.env.NO_COLOR;

const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  green: "\x1b[32m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

function paint(color: keyof typeof c, s: string): string {
  return COLOR_ENABLED ? `${c[color]}${s}${c.reset}` : s;
}

const SEV_COLOR: Record<Severity, keyof typeof c> = {
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

export function emitPretty(report: RunReport, outputFile?: string): void {
  const lines: string[] = [];

  lines.push(paint("bold", `revu ${report.runId.slice(0, 8)}`));
  lines.push(
    paint(
      "dim",
      `target: ${formatTarget(report)}  rules: ${report.rules.length}  findings: ${report.findings.length}`,
    ),
  );
  lines.push("");

  const timedOut = report.rules.filter((r) => r.timedOut);
  if (timedOut.length > 0) {
    lines.push(paint("yellow", `⏱ ${timedOut.length} rule(s) timed out — results below are partial:`));
    for (const r of timedOut) {
      lines.push(paint("yellow", `  ${r.id} (${r.findingCount} partial finding(s), ${r.durationMs}ms)`));
    }
    lines.push("");
  }

  const systemic = detectSystemicFailure(report);
  if (systemic) {
    lines.push(paint("bold", paint("red", `✗ ${systemic.scope} agent(s) failed: ${systemic.message}`)));
    const hint = hintFor(systemic.message);
    if (hint) lines.push(paint("yellow", `  → ${hint}`));
    lines.push("");
  }

  if (report.findings.length === 0) {
    lines.push(paint("green", "  no findings"));
  } else {
    const byPath = new Map<string, typeof report.findings>();
    for (const f of report.findings) {
      const list = byPath.get(f.path) ?? [];
      list.push(f);
      byPath.set(f.path, list);
    }
    for (const [path, findings] of byPath) {
      lines.push(paint("bold", path));
      for (const f of findings) {
        const sev = paint(SEV_COLOR[f.severity], SEV_LABEL[f.severity]);
        const loc = f.line !== undefined
          ? `:${f.line}${f.lineEnd && f.lineEnd !== f.line ? `-${f.lineEnd}` : ""}`
          : "";
        const cat = f.category ? paint("dim", ` [${f.category}]`) : "";
        const ruleTag = paint("dim", `(${f.ruleId})`);
        lines.push(`  ${sev}  ${path}${loc}  ${ruleTag}${cat}`);
        for (const ml of f.message.split("\n")) {
          lines.push(`        ${ml}`);
        }
      }
      lines.push("");
    }
  }

  const failed = report.rules.filter((r) => !r.ok);
  if (failed.length > 0) {
    lines.push(paint("red", `${failed.length} rule(s) errored:`));
    for (const r of failed) {
      lines.push(`  ${r.id}: ${r.errorMessage ?? "(unknown error)"}`);
    }
    lines.push("");
  }

  const text = lines.join("\n") + "\n";
  process.stdout.write(text);
  if (outputFile) {
    // Strip ANSI codes for file output.
    writeFileSync(outputFile, text.replace(/\x1b\[[0-9;]*m/g, ""), "utf8");
  }
}

function detectSystemicFailure(report: RunReport): { scope: string; message: string } | undefined {
  // Timeouts are reported in their own banner above; don't double-count.
  const failed = report.rules.filter((r) => !r.ok && !r.timedOut);
  if (failed.length === 0) return undefined;
  const messages = new Set(failed.map((r) => r.errorMessage ?? "unknown"));
  if (messages.size === 1 && failed.length === report.rules.length) {
    return { scope: `All ${failed.length}`, message: [...messages][0] ?? "unknown" };
  }
  if (messages.size === 1 && failed.length > 1) {
    return { scope: `${failed.length}/${report.rules.length}`, message: [...messages][0] ?? "unknown" };
  }
  return undefined;
}

function hintFor(message: string): string | undefined {
  const m = message.toLowerCase();
  if (m.includes("credit balance") || m.includes("credit_balance")) {
    return "Anthropic API account has no credits — top up at https://console.anthropic.com/settings/billing";
  }
  if (m.includes("invalid api key") || m.includes("authentication") || m.includes("401")) {
    return "Check ANTHROPIC_API_KEY in your environment.";
  }
  if (m.includes("rate limit") || m.includes("429")) {
    return "Rate-limited by the Anthropic API — try a lower --concurrency or a different model.";
  }
  if (m.includes("overloaded") || m.includes("529")) {
    return "Anthropic API is overloaded; retry in a moment.";
  }
  if (m.includes("model") && (m.includes("not found") || m.includes("does not exist"))) {
    return "Model identifier was rejected — pass --model with a valid id.";
  }
  return undefined;
}

function formatTarget(report: RunReport): string {
  const t = report.reviewTarget;
  if (t.mode === "ref-range") {
    const target = t.target;
    if (target.mode === "ref-range") {
      return `${target.base}...${target.head} (${t.changedFiles.length} files)`;
    }
  }
  if (t.mode === "working-tree") return `working tree (${t.changedFiles.length} files)`;
  if (t.mode === "staged") return `staged (${t.changedFiles.length} files)`;
  return t.mode;
}
