import { describe, it, expect } from "vitest";
import { extractMarkers, fingerprint } from "../../src/forges/dedup.js";
import { renderCommentBody, renderTopLevelBody } from "../../src/forges/render.js";
import type { Finding } from "../../src/types.js";

const F: Finding = {
  ruleId: "dead-code",
  severity: "high",
  path: "src/foo.ts",
  line: 42,
  message: "unused export `foo`",
};

describe("renderCommentBody", () => {
  it("includes a severity badge, rule id, message, and a fingerprint marker", () => {
    const body = renderCommentBody(F);
    expect(body).toContain("🔴 high");
    expect(body).toContain("`dead-code`");
    expect(body).toContain("unused export");
    expect(extractMarkers(body)).toEqual([fingerprint(F)]);
  });

  it("uses different badges per severity", () => {
    expect(renderCommentBody({ ...F, severity: "critical" })).toContain("⛔ critical");
    expect(renderCommentBody({ ...F, severity: "medium" })).toContain("🟡 medium");
    expect(renderCommentBody({ ...F, severity: "low" })).toContain("🔵 low");
    expect(renderCommentBody({ ...F, severity: "aesthetic" })).toContain("⚪ aesthetic");
  });

  it("includes the category when present", () => {
    expect(renderCommentBody({ ...F, category: "unused-export" })).toContain("_unused-export_");
  });

  it("survives multi-line messages", () => {
    const body = renderCommentBody({ ...F, message: "line one\nline two" });
    expect(body).toContain("line one");
    expect(body).toContain("line two");
  });
});

describe("renderTopLevelBody", () => {
  it("emits a one-line summary with the counts", () => {
    const body = renderTopLevelBody(
      { total: 5, newCount: 3, alreadyPosted: 2, outOfDiff: 0 },
      [],
    );
    expect(body).toContain("5 finding");
    expect(body).toContain("3 new");
    expect(body).toContain("2 already posted");
    expect(body).toContain("0 outside the diff");
  });

  it("lists out-of-diff findings grouped by file", () => {
    const ood: Finding[] = [
      { ruleId: "r1", severity: "low", path: "a.ts", line: 1, message: "a-msg" },
      { ruleId: "r2", severity: "medium", path: "a.ts", line: 2, message: "another" },
      { ruleId: "r3", severity: "high", path: "b.ts", message: "b-msg" },
    ];
    const body = renderTopLevelBody(
      { total: 3, newCount: 3, alreadyPosted: 0, outOfDiff: 3 },
      ood,
    );
    expect(body).toContain("Findings outside the PR diff");
    expect(body).toContain("`a.ts`");
    expect(body).toContain("`b.ts`");
    expect(body).toContain("`r1`");
    expect(body).toContain("a-msg");
    expect(body).toContain("b-msg");
  });
});
