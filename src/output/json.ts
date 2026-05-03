import { writeFileSync } from "node:fs";
import type { RunReport } from "../types.js";

export function emitJson(report: RunReport, outputFile?: string): void {
  const text = JSON.stringify(report, null, 2);
  process.stdout.write(text + "\n");
  if (outputFile) {
    writeFileSync(outputFile, text + "\n", "utf8");
  }
}
