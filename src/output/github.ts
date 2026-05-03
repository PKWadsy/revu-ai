import { writeFileSync } from "node:fs";
import type { Finding, RunReport, Severity } from "../types.js";

const SEV_COMMAND: Record<Severity, "notice" | "warning" | "error"> = {
  aesthetic: "notice",
  low: "notice",
  medium: "warning",
  high: "error",
  critical: "error",
};

export function emitGithub(report: RunReport, outputFile?: string): void {
  const lines: string[] = [];
  for (const f of report.findings) {
    lines.push(formatLine(f));
  }
  const text = lines.length ? lines.join("\n") + "\n" : "";
  process.stdout.write(text);
  if (outputFile) {
    writeFileSync(outputFile, text, "utf8");
  }
}

function formatLine(f: Finding): string {
  const command = SEV_COMMAND[f.severity];
  const params: string[] = [`file=${escape(f.path)}`];
  if (f.line !== undefined) params.push(`line=${f.line}`);
  if (f.lineEnd !== undefined) params.push(`endLine=${f.lineEnd}`);
  params.push(`title=${escape(`revu-ai / ${f.ruleId} (${f.severity})`)}`);
  return `::${command} ${params.join(",")}::${escapeMessage(f.message)}`;
}

function escape(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/:/g, "%3A").replace(/,/g, "%2C");
}

function escapeMessage(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}
