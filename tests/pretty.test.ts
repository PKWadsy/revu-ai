import { describe, it, expect } from "vitest";
import {
  detectIncompleteReviews,
  detectPossiblySilencedRules,
  detectGatedRules,
  SILENCED_TEXT_THRESHOLD,
} from "../src/output/pretty.js";
import type { RunReport, RuleResult } from "../src/types.js";

function makeReport(rules: RuleResult[]): RunReport {
  return {
    schemaVersion: 3,
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
    summaries: [],
    checks: [],
  };
}

const BASE_COUNTS = { summaryCount: 1, checkCount: 0 } as const;

describe("detectPossiblySilencedRules", () => {
  it("flags rules with substantive text output but zero findings (and no summary)", () => {
    const report = makeReport([
      {
        id: ".revu/alpha",
        path: ".revu/alpha.revu.md",
        ok: true,
        durationMs: 100,
        findingCount: 0,
        summaryCount: 0,
        checkCount: 0,
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
        ...BASE_COUNTS,
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
        ...BASE_COUNTS,
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
        ...BASE_COUNTS,
        errorMessage: "boom",
        diagnostics: { textChars: 5000, findingToolCalls: 0 },
      },
      {
        id: ".revu/timed-out",
        path: ".revu/timed-out.revu.md",
        ok: false,
        durationMs: 60000,
        findingCount: 0,
        ...BASE_COUNTS,
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
        ...BASE_COUNTS,
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
        ...BASE_COUNTS,
      },
    ]);
    expect(detectPossiblySilencedRules(report)).toEqual([]);
  });

  it("does not flag rules that emitted a review summary — prose is narration around real tool calls, not lost findings", () => {
    const report = makeReport([
      {
        id: ".revu/alpha",
        path: ".revu/alpha.revu.md",
        ok: true,
        durationMs: 100,
        findingCount: 0,
        summaryCount: 1,
        checkCount: 5,
        diagnostics: { textChars: SILENCED_TEXT_THRESHOLD * 10, findingToolCalls: 0 },
      },
    ]);
    expect(detectPossiblySilencedRules(report)).toEqual([]);
  });

  it("does not flag gated rules (they never ran, so 'lost findings' isn't the story)", () => {
    const report = makeReport([
      {
        id: ".revu/gated",
        path: ".revu/gated.revu.md",
        ok: true,
        durationMs: 0,
        findingCount: 0,
        summaryCount: 0,
        checkCount: 0,
        gated: true,
        // A defensive provider could still attach diagnostics; gating must win.
        diagnostics: { textChars: SILENCED_TEXT_THRESHOLD * 10, findingToolCalls: 0 },
      },
    ]);
    expect(detectPossiblySilencedRules(report)).toEqual([]);
  });
});

describe("detectIncompleteReviews", () => {
  it("flags healthy rules with no review summary", () => {
    const report = makeReport([
      {
        id: ".revu/alpha",
        path: ".revu/alpha.revu.md",
        ok: true,
        durationMs: 100,
        findingCount: 0,
        summaryCount: 0,
        checkCount: 0,
      },
    ]);
    expect(detectIncompleteReviews(report)).toEqual([{ id: ".revu/alpha" }]);
  });

  it("does not flag rules that DID call report_review_summary", () => {
    const report = makeReport([
      {
        id: ".revu/alpha",
        path: ".revu/alpha.revu.md",
        ok: true,
        durationMs: 100,
        findingCount: 0,
        summaryCount: 1,
        checkCount: 0,
      },
    ]);
    expect(detectIncompleteReviews(report)).toEqual([]);
  });

  it("does not flag errored, timed-out, or skipped rules (other banners cover them)", () => {
    const report = makeReport([
      {
        id: ".revu/failed",
        path: ".revu/failed.revu.md",
        ok: false,
        durationMs: 100,
        findingCount: 0,
        summaryCount: 0,
        checkCount: 0,
        errorMessage: "boom",
      },
      {
        id: ".revu/timed-out",
        path: ".revu/timed-out.revu.md",
        ok: false,
        durationMs: 60000,
        findingCount: 0,
        summaryCount: 0,
        checkCount: 0,
        timedOut: true,
      },
      {
        id: ".revu/skipped",
        path: ".revu/skipped.revu.md",
        ok: true,
        durationMs: 0,
        findingCount: 0,
        summaryCount: 0,
        checkCount: 0,
        skipped: true,
      },
    ]);
    expect(detectIncompleteReviews(report)).toEqual([]);
  });

  it("flags multiple healthy rules that all silently exited", () => {
    const report = makeReport([
      { id: "a", path: "a.revu.md", ok: true, durationMs: 1, findingCount: 0, summaryCount: 0, checkCount: 0 },
      { id: "b", path: "b.revu.md", ok: true, durationMs: 1, findingCount: 2, summaryCount: 0, checkCount: 0 },
      { id: "c", path: "c.revu.md", ok: true, durationMs: 1, findingCount: 0, summaryCount: 1, checkCount: 3 },
    ]);
    expect(detectIncompleteReviews(report).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("does not flag gated rules as incomplete — they never ran because an earlier stage tripped the gate", () => {
    const report = makeReport([
      {
        id: ".revu/gated",
        path: ".revu/gated.revu.md",
        ok: true,
        durationMs: 0,
        findingCount: 0,
        summaryCount: 0,
        checkCount: 0,
        gated: true,
      },
    ]);
    expect(detectIncompleteReviews(report)).toEqual([]);
  });
});

describe("detectGatedRules", () => {
  it("returns the rules that did not run because an earlier stage tripped the gate", () => {
    const report = makeReport([
      { id: ".revu/ran", path: ".revu/ran.revu.md", ok: true, durationMs: 10, findingCount: 1, summaryCount: 1, checkCount: 0 },
      { id: ".revu/gated-a", path: ".revu/gated-a.revu.md", ok: true, durationMs: 0, findingCount: 0, summaryCount: 0, checkCount: 0, gated: true },
      { id: ".revu/gated-b", path: ".revu/gated-b.revu.md", ok: true, durationMs: 0, findingCount: 0, summaryCount: 0, checkCount: 0, gated: true },
    ]);
    expect(detectGatedRules(report).map((r) => r.id)).toEqual([".revu/gated-a", ".revu/gated-b"]);
  });

  it("returns an empty list when nothing was gated", () => {
    const report = makeReport([
      { id: ".revu/ran", path: ".revu/ran.revu.md", ok: true, durationMs: 10, findingCount: 0, summaryCount: 1, checkCount: 0 },
    ]);
    expect(detectGatedRules(report)).toEqual([]);
  });
});
