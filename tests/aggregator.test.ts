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
});
