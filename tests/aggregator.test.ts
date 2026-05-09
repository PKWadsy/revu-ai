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
});
