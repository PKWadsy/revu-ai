import type { Finding, Severity } from "../types.js";
import { fingerprint, withMarker } from "./dedup.js";

// `Record<Severity, …>` makes `SEVERITIES` (in src/types.ts) the single source of
// truth — adding a new severity there fails typecheck here until this map is
// extended. Same pattern is reused for the cli's SEV_COLOR / SEV_LABEL maps.
const SEV_BADGE: Record<Severity, string> = {
  aesthetic: "⚪ aesthetic",
  low: "🔵 low",
  medium: "🟡 medium",
  high: "🔴 high",
  critical: "⛔ critical",
};

/**
 * Render a single finding as a Markdown comment body, with a hidden HTML
 * marker appended for dedup on subsequent runs.
 */
export function renderCommentBody(finding: Finding): string {
  const fp = fingerprint(finding);
  const header = `**${SEV_BADGE[finding.severity]}** \`${finding.ruleId}\``;
  const category = finding.category ? `  _${finding.category}_` : "";
  const body = `${header}${category}\n\n${finding.message.trim()}`;
  return withMarker(body, fp);
}

export interface SummaryStats {
  total: number;
  newCount: number;
  alreadyPosted: number;
  outOfDiff: number;
}

/**
 * Render the top-level review body. Includes a one-line summary and, if any,
 * a section listing findings that couldn't be posted inline because the line
 * isn't in the PR diff.
 */
export function renderTopLevelBody(stats: SummaryStats, outOfDiff: Finding[]): string {
  const sections: string[] = [];
  sections.push(
    `**revu-ai** found ${stats.total} finding${stats.total === 1 ? "" : "s"} — ` +
      `${stats.newCount} new, ${stats.alreadyPosted} already posted, ${stats.outOfDiff} outside the diff.`,
  );

  if (outOfDiff.length > 0) {
    sections.push("### Findings outside the PR diff");
    const byPath = groupByPath(outOfDiff);
    for (const [path, findings] of byPath) {
      sections.push(`- \`${path}\``);
      for (const f of findings) {
        const loc = f.line !== undefined ? `:${f.line}${f.lineEnd && f.lineEnd !== f.line ? `-${f.lineEnd}` : ""}` : "";
        sections.push(
          `  - ${SEV_BADGE[f.severity]} \`${f.ruleId}\`${loc} — ${oneLine(f.message)}`,
        );
      }
    }
  }

  return sections.join("\n\n");
}

function groupByPath(findings: Finding[]): Map<string, Finding[]> {
  const out = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = out.get(f.path);
    if (list) list.push(f);
    else out.set(f.path, [f]);
  }
  return out;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
