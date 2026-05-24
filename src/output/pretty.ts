import type { RunReport, Severity } from "../types.js";

/** Minimum text-output volume (characters of trimmed assistant prose) at which
 *  a rule that produced zero findings starts to look like "model talked but
 *  didn't call the MCP tool" rather than "model genuinely found nothing".
 *  Set generously — Claude routinely emits ~100 chars of preamble even when
 *  silent is correct; we only want to flag clearly substantive prose. */
export const SILENCED_TEXT_THRESHOLD = 200;

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

export function emitPretty(report: RunReport): void {
  const lines: string[] = [];

  lines.push(paint("bold", `revu-ai ${report.runId.slice(0, 8)}`));
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

  const silenced = detectPossiblySilencedRules(report);
  if (silenced.length > 0) {
    lines.push(paint("yellow", `⚠ ${silenced.length} rule(s) emitted substantial text but reported 0 findings —`));
    lines.push(paint("yellow", "  the model may have described findings as prose instead of calling \`mcp__revu__report_finding\`."));
    lines.push(paint("yellow", "  Re-run with REVU_DEBUG=1 to inspect agent output, or try a different model."));
    for (const r of silenced) {
      lines.push(paint("dim", `    ${r.id}  (${r.textChars} chars of agent text, 0 findings)`));
    }
    lines.push("");
  }

  const incomplete = detectIncompleteReviews(report);
  if (incomplete.length > 0) {
    lines.push(paint("yellow", `⚠ ${incomplete.length} rule(s) did not call \`mcp__revu__report_review_summary\` — likely incomplete review.`));
    lines.push(paint("yellow", "  Healthy runs end with one summary call per rule. A missing summary means the agent"));
    lines.push(paint("yellow", "  silently exited or never reached the MCP — treat the absence of findings with caution."));
    for (const r of incomplete) {
      lines.push(paint("dim", `    ${r.id}  (no review summary)`));
    }
    lines.push("");
  }

  // Render compliance evidence + per-rule summaries, grouped by rule. These
  // show what the agents verified — the "show your work" surface that gives
  // a clean run more credibility than just a green tick.
  const ruleIds = Array.from(
    new Set([
      ...(report.summaries ?? []).map((s) => s.ruleId),
      ...(report.checks ?? []).map((c) => c.ruleId),
    ]),
  ).sort();
  if (ruleIds.length > 0) {
    lines.push(paint("bold", "verified"));
    for (const ruleId of ruleIds) {
      const summary = (report.summaries ?? []).find((s) => s.ruleId === ruleId);
      const checks = (report.checks ?? []).filter((c) => c.ruleId === ruleId);
      const tickColor: keyof typeof c = summary?.outcome === "concerns" ? "yellow" : "green";
      const outcomeTag = summary
        ? paint("dim", summary.outcome === "pass" ? " [pass]" : " [concerns]")
        : paint("yellow", " [no summary]");
      lines.push(`  ${paint(tickColor, "✓")} ${paint("bold", ruleId)}${outcomeTag}`);
      for (const chk of checks) {
        const loc = chk.line !== undefined
          ? `:${chk.line}${chk.lineEnd && chk.lineEnd !== chk.line ? `-${chk.lineEnd}` : ""}`
          : "";
        const cat = chk.category ? paint("dim", ` [${chk.category}]`) : "";
        lines.push(`      ${paint("green", "·")} ${paint("dim", `${chk.path}${loc}`)}${cat} ${chk.message}`);
      }
      if (summary) {
        for (const ml of summary.checked.split("\n")) {
          lines.push(paint("dim", `      checked: ${ml}`));
        }
        for (const ml of summary.rationale.split("\n")) {
          lines.push(paint("dim", `      why: ${ml}`));
        }
      }
    }
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

  process.stdout.write(lines.join("\n") + "\n");
}

/** Rules that finished healthily (not errored, not timed out, not skipped)
 *  but did not call `report_review_summary` — agents are required to sign off
 *  with exactly one summary call, so absence means the agent either silently
 *  exited or never reached the MCP. The pretty output surfaces this as a
 *  prominent warning so a "no findings" result isn't mistaken for a clean
 *  review. */
export function detectIncompleteReviews(report: RunReport): Array<{ id: string }> {
  return report.rules
    .filter(
      (r) =>
        r.ok &&
        !r.timedOut &&
        !r.skipped &&
        (r.summaryCount ?? 0) === 0,
    )
    .map((r) => ({ id: r.id }));
}

/** Rules where the agent emitted substantial assistant prose but reported no
 *  findings — symptomatic of a model that wrote its findings as text instead
 *  of calling the MCP tool. Excludes errored, timed-out, and skipped rules
 *  (those have their own banners and the text-loss story doesn't apply).
 *
 *  Also suppressed when the rule emitted a `report_review_summary` call. The
 *  summary call is a stronger signal that the agent followed the protocol —
 *  in the v3 world, an agent that signed off is producing prose around real
 *  tool calls (narration, per-check rationale), not lost findings. The
 *  `detectIncompleteReviews` banner is the better warning when there's no
 *  summary, and we don't want both firing on the same rule. */
export function detectPossiblySilencedRules(
  report: RunReport,
): Array<{ id: string; textChars: number }> {
  return report.rules
    .filter(
      (r) =>
        r.ok &&
        !r.timedOut &&
        !r.skipped &&
        r.findingCount === 0 &&
        (r.summaryCount ?? 0) === 0 &&
        r.diagnostics !== undefined &&
        r.diagnostics.textChars >= SILENCED_TEXT_THRESHOLD,
    )
    .map((r) => ({ id: r.id, textChars: r.diagnostics!.textChars }));
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
