import type { RunReport } from "../types.js";

/** Emit the run report as JSON to stdout. The file-side counterpart is always
 *  JSON regardless of stdout format — see `writeReportFile` for that. */
export function emitJson(report: RunReport): void {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}
