import { describe, it, expect } from "vitest";
import { detectPossiblySilencedRules, SILENCED_TEXT_THRESHOLD } from "../src/output/pretty.js";
import type { RunReport, RuleResult } from "../src/types.js";

function makeReport(rules: RuleResult[]): RunReport {
  return {
    schemaVersion: 2,
    runId: "test-run-id",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    reviewTarget: {
      mode: "ref-range",
      baseSha: "0000000",
      headSha: "1111111",
      changedFiles: [],
      target: { mode: "ref-range", base: "origin/main", head: "HEAD" },
    },
    rules,
    findings: [],
    resolutions: [],
  };
}

describe("detectPossiblySilencedRules", () => {
  it("flags rules with substantive text output but zero findings", () => {
    const report = makeReport([
      {
        id: ".revu/alpha",
        path: ".revu/alpha.revu.md",
        ok: true,
        durationMs: 100,
        findingCount: 0,
        diagnostics: { textChars: SILENCED_TEXT_THRESHOLD + 50, findingToolCalls: 0 },
      },
    ]);
    const suspected = detectPossiblySilencedRules(report);
    expect(suspected).toEqual([
      { id: ".revu/alpha", textChars: SILENCED_TEXT_THRESHOLD + 50 },
    ]);
  });

  it("does not flag rules that produced findings", () => {
    const report = makeReport([
      {
        id: ".revu/alpha",
        path: ".revu/alpha.revu.md",
        ok: true,
        durationMs: 100,
        findingCount: 3,
        diagnostics: { textChars: 5000, findingToolCalls: 3 },
      },
    ]);
    expect(detectPossiblySilencedRules(report)).toEqual([]);
  });

  it("does not flag rules whose text output is below the threshold", () => {
    const report = makeReport([
      {
        id: ".revu/alpha",
        path: ".revu/alpha.revu.md",
        ok: true,
        durationMs: 100,
        findingCount: 0,
        diagnostics: { textChars: 50, findingToolCalls: 0 },
      },
    ]);
    expect(detectPossiblySilencedRules(report)).toEqual([]);
  });

  it("does not flag rules that failed or timed out (text loss isn't the story there)", () => {
    const report = makeReport([
      {
        id: ".revu/failed",
        path: ".revu/failed.revu.md",
        ok: false,
        durationMs: 100,
        findingCount: 0,
        errorMessage: "boom",
        diagnostics: { textChars: 5000, findingToolCalls: 0 },
      },
      {
        id: ".revu/timed-out",
        path: ".revu/timed-out.revu.md",
        ok: false,
        durationMs: 60000,
        findingCount: 0,
        timedOut: true,
        diagnostics: { textChars: 5000, findingToolCalls: 0 },
      },
    ]);
    expect(detectPossiblySilencedRules(report)).toEqual([]);
  });

  it("does not flag skipped rules", () => {
    const report = makeReport([
      {
        id: ".revu/skipped",
        path: ".revu/skipped.revu.md",
        ok: true,
        durationMs: 0,
        findingCount: 0,
        skipped: true,
      },
    ]);
    expect(detectPossiblySilencedRules(report)).toEqual([]);
  });

  it("does not flag rules with no diagnostics field (legacy providers)", () => {
    const report = makeReport([
      {
        id: ".revu/legacy",
        path: ".revu/legacy.revu.md",
        ok: true,
        durationMs: 100,
        findingCount: 0,
      },
    ]);
    expect(detectPossiblySilencedRules(report)).toEqual([]);
  });
});
