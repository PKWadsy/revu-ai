import { readFileSync, writeFileSync } from "node:fs";
import { getForge } from "./registry.js";
import type { PostResult, ResolveContextFlags } from "./types.js";
import type { RunReport, Severity } from "../types.js";

export interface ForgePostOptions {
  forge: string;
  reportPath: string;
  /** Optional path to a prior --output-file report. When present, the post step PATCHes
   *  existing comments instead of always creating fresh ones. */
  priorReportPath?: string;
  /** Optional path to write the augmented report to (with commentIds populated, etc.).
   *  This file is what next run feeds back as --prior-report. */
  outputFile?: string;
  flags: ResolveContextFlags;
  requestChangesAtOrAbove?: Severity;
  dryRun: boolean;
  /** Optional injected env. Defaults to process.env. Useful in tests. */
  env?: NodeJS.ProcessEnv;
  /** Optional injected stdin reader for `--report -`. Useful in tests. */
  readStdin?: () => Promise<string>;
}

export async function runForgePost(options: ForgePostOptions): Promise<PostResult> {
  const reportText = options.reportPath === "-"
    ? await (options.readStdin ?? defaultReadStdin)()
    : readFileSync(options.reportPath, "utf8");

  const report = JSON.parse(reportText) as RunReport;
  if (report.schemaVersion !== 2 && (report.schemaVersion as number) !== 1) {
    throw new Error(`Unsupported report schemaVersion ${String(report.schemaVersion)}; expected 1 or 2.`);
  }

  let priorReport: RunReport | undefined;
  if (options.priorReportPath) {
    try {
      const priorText = readFileSync(options.priorReportPath, "utf8");
      priorReport = JSON.parse(priorText) as RunReport;
      if (priorReport.schemaVersion !== 2 && (priorReport.schemaVersion as number) !== 1) {
        throw new Error(
          `Unsupported prior report schemaVersion ${String(priorReport.schemaVersion)}; expected 1 or 2.`,
        );
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw e;
      // Missing prior file is normal on the first run; just proceed without one.
      priorReport = undefined;
    }
  }

  const adapter = getForge(options.forge);
  const env = options.env ?? process.env;
  const context = await adapter.resolveContext(env, options.flags);

  const result = await adapter.post({
    report,
    ...(priorReport ? { priorReport } : {}),
    context,
    ...(options.requestChangesAtOrAbove ? { requestChangesAtOrAbove: options.requestChangesAtOrAbove } : {}),
    dryRun: options.dryRun,
  });

  if (options.outputFile) {
    writeFileSync(options.outputFile, JSON.stringify(result.augmentedReport, null, 2) + "\n", "utf8");
  }

  return result;
}

function defaultReadStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}
