import { describe, it, expect } from "vitest";
import { FindingsAggregator } from "../src/mcp/aggregator.js";

describe("FindingsAggregator", () => {
  it("records distinct findings", () => {
    const agg = new FindingsAggregator();
    expect(agg.add({ ruleId: "r", severity: "low", path: "a.ts", message: "m1" })).toBe(true);
    expect(agg.add({ ruleId: "r", severity: "low", path: "a.ts", message: "m2" })).toBe(true);
    expect(agg.all()).toHaveLength(2);
  });

  it("dedupes identical findings (same rule + path + line + message)", () => {
    const agg = new FindingsAggregator();
    const f = { ruleId: "r", severity: "high", path: "a.ts", line: 5, message: "boom" } as const;
    expect(agg.add(f)).toBe(true);
    expect(agg.add(f)).toBe(false);
    expect(agg.all()).toHaveLength(1);
  });

  it("treats different lines as different findings", () => {
    const agg = new FindingsAggregator();
    agg.add({ ruleId: "r", severity: "low", path: "a.ts", line: 1, message: "m" });
    agg.add({ ruleId: "r", severity: "low", path: "a.ts", line: 2, message: "m" });
    expect(agg.all()).toHaveLength(2);
  });

  it("counts findings per rule", () => {
    const agg = new FindingsAggregator();
    agg.add({ ruleId: "a", severity: "low", path: "x", message: "1" });
    agg.add({ ruleId: "a", severity: "low", path: "x", message: "2" });
    agg.add({ ruleId: "b", severity: "low", path: "x", message: "1" });
    expect(agg.countFor("a")).toBe(2);
    expect(agg.countFor("b")).toBe(1);
    expect(agg.countFor("c")).toBe(0);
  });

  it("reports max severity across all findings", () => {
    const agg = new FindingsAggregator();
    expect(agg.maxSeverity()).toBeUndefined();
    agg.add({ ruleId: "r", severity: "low", path: "a", message: "1" });
    agg.add({ ruleId: "r", severity: "critical", path: "a", message: "2" });
    agg.add({ ruleId: "r", severity: "medium", path: "a", message: "3" });
    expect(agg.maxSeverity()).toBe("critical");
  });

  it("records resolutions with reason and resolvedAtSha", () => {
    const agg = new FindingsAggregator();
    expect(agg.markResolved("r1", "fp-abc", "fixed", "sha1")).toBe(true);
    expect(agg.markResolved("r1", "fp-def", "stale", "sha2")).toBe(true);
    expect(agg.allResolutions()).toEqual([
      { ruleId: "r1", fingerprint: "fp-abc", reason: "fixed", resolvedAtSha: "sha1" },
      { ruleId: "r1", fingerprint: "fp-def", reason: "stale", resolvedAtSha: "sha2" },
    ]);
  });

  it("dedupes identical resolutions (same ruleId + fingerprint)", () => {
    const agg = new FindingsAggregator();
    expect(agg.markResolved("r1", "fp-abc", "fixed")).toBe(true);
    expect(agg.markResolved("r1", "fp-abc", "fixed")).toBe(false);
    expect(agg.markResolved("r1", "fp-abc", "stale")).toBe(false); // dedup is by id+fp, reason ignored
    expect(agg.allResolutions()).toHaveLength(1);
  });

  it("treats the same fingerprint under different rules as distinct resolutions", () => {
    const agg = new FindingsAggregator();
    agg.markResolved("r1", "fp-abc", "fixed");
    agg.markResolved("r2", "fp-abc", "fixed");
    expect(agg.allResolutions()).toHaveLength(2);
  });

  it("scopes resolutionsFor() to the requested ruleId", () => {
    const agg = new FindingsAggregator();
    agg.markResolved("r1", "fp-1", "fixed");
    agg.markResolved("r1", "fp-2", "stale");
    agg.markResolved("r2", "fp-3", "fixed");
    expect(agg.resolutionsFor("r1").map((r) => r.fingerprint).sort()).toEqual(["fp-1", "fp-2"]);
    expect(agg.resolutionsFor("r2").map((r) => r.fingerprint)).toEqual(["fp-3"]);
    expect(agg.resolutionsFor("nope")).toEqual([]);
  });

  it("fires onResolution listeners for each new resolution but not for dedupes", () => {
    const agg = new FindingsAggregator();
    const seen: string[] = [];
    const unsubscribe = agg.onResolution((r) => seen.push(`${r.ruleId}:${r.fingerprint}`));

    agg.markResolved("r1", "fp-a", "fixed");
    agg.markResolved("r1", "fp-a", "fixed"); // dedup → no listener call
    agg.markResolved("r1", "fp-b", "stale");

    unsubscribe();
    agg.markResolved("r1", "fp-c", "fixed"); // after unsubscribe → no listener call

    expect(seen).toEqual(["r1:fp-a", "r1:fp-b"]);
  });

  it("defaults resolvedAtSha to empty when omitted", () => {
    const agg = new FindingsAggregator();
    agg.markResolved("r1", "fp-x", "fixed");
    expect(agg.allResolutions()[0]?.resolvedAtSha).toBe("");
  });

  describe("review summaries", () => {
    it("records one summary per rule and rejects duplicates", () => {
      const agg = new FindingsAggregator();
      expect(
        agg.addSummary({ ruleId: "r1", outcome: "pass", checked: "src/x.ts", rationale: "ok" }),
      ).toBe(true);
      expect(
        agg.addSummary({ ruleId: "r1", outcome: "concerns", checked: "again", rationale: "no" }),
      ).toBe(false);
      expect(agg.summaryFor("r1")).toMatchObject({ outcome: "pass", checked: "src/x.ts" });
      expect(agg.summaryCountFor("r1")).toBe(1);
      expect(agg.summaryCountFor("never-reported")).toBe(0);
    });

    it("keeps summaries from different rules independent", () => {
      const agg = new FindingsAggregator();
      agg.addSummary({ ruleId: "r1", outcome: "pass", checked: "a", rationale: "x" });
      agg.addSummary({ ruleId: "r2", outcome: "concerns", checked: "b", rationale: "y" });
      expect(agg.allSummaries().map((s) => s.ruleId).sort()).toEqual(["r1", "r2"]);
    });

    it("fires onSummary for the first call and not for the duplicate", () => {
      const agg = new FindingsAggregator();
      const seen: string[] = [];
      const unsub = agg.onSummary((s) => seen.push(s.ruleId));
      agg.addSummary({ ruleId: "r1", outcome: "pass", checked: "a", rationale: "b" });
      agg.addSummary({ ruleId: "r1", outcome: "pass", checked: "a", rationale: "b" });
      unsub();
      agg.addSummary({ ruleId: "r2", outcome: "pass", checked: "a", rationale: "b" });
      expect(seen).toEqual(["r1"]);
    });
  });

  describe("still-open acknowledgements", () => {
    it("records open confirmations per rule and dedupes by fingerprint", () => {
      const agg = new FindingsAggregator();
      expect(agg.markOpen("r1", "fp-a")).toBe(true);
      expect(agg.markOpen("r1", "fp-a")).toBe(false); // dedup
      expect(agg.markOpen("r1", "fp-b")).toBe(true);
      expect(agg.openFor("r1").sort()).toEqual(["fp-a", "fp-b"]);
      expect(agg.openFor("nope")).toEqual([]);
    });

    it("scopes open confirmations per rule and exposes them via allOpen()", () => {
      const agg = new FindingsAggregator();
      agg.markOpen("r1", "fp-a");
      agg.markOpen("r2", "fp-a"); // same fp, different rule → distinct
      expect(agg.allOpen().sort((a, b) => a.ruleId.localeCompare(b.ruleId))).toEqual([
        { ruleId: "r1", fingerprint: "fp-a" },
        { ruleId: "r2", fingerprint: "fp-a" },
      ]);
    });
  });

  describe("compliance checks", () => {
    it("records and counts checks per rule", () => {
      const agg = new FindingsAggregator();
      expect(agg.addCheck({ ruleId: "r1", path: "a.ts", line: 1, message: "ok" })).toBe(true);
      expect(agg.addCheck({ ruleId: "r1", path: "b.ts", message: "ok2" })).toBe(true);
      expect(agg.addCheck({ ruleId: "r2", path: "c.ts", message: "ok3" })).toBe(true);
      expect(agg.checkCountFor("r1")).toBe(2);
      expect(agg.checkCountFor("r2")).toBe(1);
      expect(agg.allChecks()).toHaveLength(3);
    });

    it("dedupes identical checks (same rule + path + line + message)", () => {
      const agg = new FindingsAggregator();
      const c = { ruleId: "r1", path: "a.ts", line: 1, message: "same" } as const;
      expect(agg.addCheck(c)).toBe(true);
      expect(agg.addCheck(c)).toBe(false);
      expect(agg.checkCountFor("r1")).toBe(1);
    });

    it("fires onCheck listeners on each accepted check", () => {
      const agg = new FindingsAggregator();
      const seen: string[] = [];
      const unsub = agg.onCheck((c) => seen.push(c.path));
      agg.addCheck({ ruleId: "r1", path: "a", message: "x" });
      agg.addCheck({ ruleId: "r1", path: "a", message: "x" }); // dedup
      agg.addCheck({ ruleId: "r1", path: "b", message: "y" });
      unsub();
      agg.addCheck({ ruleId: "r1", path: "c", message: "z" });
      expect(seen).toEqual(["a", "b"]);
    });
  });
});
