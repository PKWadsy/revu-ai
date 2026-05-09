import { describe, it, expect } from "vitest";
import { buildActionPlan } from "../../src/cache/cross-reference.js";
import { computeFingerprint } from "../../src/findings.js";
import type { Finding, RunReport } from "../../src/types.js";

function mkFinding(opts: Partial<Finding> & Pick<Finding, "ruleId" | "path" | "message">): Finding {
  const base = {
    severity: "high" as const,
    line: 1,
    ...opts,
  };
  return {
    ...base,
    fingerprint: opts.fingerprint ?? computeFingerprint(base),
  };
}

function mkReport(opts: { headSha: string; findings: Finding[]; resolutions?: RunReport["resolutions"] }): RunReport {
  return {
    schemaVersion: 2,
    runId: "x",
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(1).toISOString(),
    reviewTarget: {
      target: { mode: "ref-range", base: "main", head: "HEAD" },
      baseSha: "b".repeat(40),
      headSha: opts.headSha,
      changedFiles: [],
      mode: "ref-range",
    },
    rules: [],
    findings: opts.findings,
    resolutions: opts.resolutions ?? [],
  };
}

describe("buildActionPlan", () => {
  it("first run (no prior) — every current finding becomes a POST", () => {
    const cur = mkReport({
      headSha: "h1",
      findings: [
        mkFinding({ ruleId: "r", path: "a.ts", message: "x", line: 1 }),
        mkFinding({ ruleId: "r", path: "b.ts", message: "y", line: 5 }),
      ],
    });
    const plan = buildActionPlan(undefined, cur);
    expect(plan.posts).toHaveLength(2);
    expect(plan.patchesResolved).toEqual([]);
    expect(plan.patchesMoved).toEqual([]);
    expect(plan.outputFindings).toHaveLength(2);
    expect(plan.outputFindings[0]?.firstSeenSha).toBe("h1");
    expect(plan.outputFindings[0]?.lastSeenSha).toBe("h1");
  });

  it("replay (no changes) — zero patches, zero posts, carry forward with bumped lastSeenSha", () => {
    const f = { ...mkFinding({ ruleId: "r", path: "a.ts", message: "x", line: 1 }), commentId: 100, firstSeenSha: "h1", lastSeenSha: "h1" };
    const prior = mkReport({ headSha: "h1", findings: [f] });
    // Current run: agent stayed silent on this finding because it's still open at the same place.
    const cur = mkReport({ headSha: "h2", findings: [] });
    const plan = buildActionPlan(prior, cur);
    expect(plan.posts).toEqual([]);
    expect(plan.patchesResolved).toEqual([]);
    expect(plan.patchesMoved).toEqual([]);
    expect(plan.outputFindings).toHaveLength(1);
    expect(plan.outputFindings[0]?.commentId).toBe(100);
    expect(plan.outputFindings[0]?.firstSeenSha).toBe("h1");
    expect(plan.outputFindings[0]?.lastSeenSha).toBe("h2");
  });

  it("resolution — emits PATCH-resolved, drops the finding from outputFindings", () => {
    const f = { ...mkFinding({ ruleId: "r", path: "a.ts", message: "x", line: 1 }), commentId: 100, firstSeenSha: "h1", lastSeenSha: "h1" };
    const prior = mkReport({ headSha: "h1", findings: [f] });
    const cur = mkReport({
      headSha: "h2",
      findings: [],
      resolutions: [{ ruleId: "r", fingerprint: f.fingerprint, reason: "fixed", resolvedAtSha: "h2" }],
    });
    const plan = buildActionPlan(prior, cur);
    expect(plan.patchesResolved).toHaveLength(1);
    expect(plan.patchesResolved[0]?.commentId).toBe(100);
    expect(plan.patchesResolved[0]?.reason).toBe("fixed");
    expect(plan.outputFindings).toEqual([]);
    expect(plan.outputResolutions).toHaveLength(1);
  });

  it("moved finding — emits PATCH-moved, carries forward commentId + firstSeenSha", () => {
    const oldFinding = { ...mkFinding({ ruleId: "r", path: "a.ts", message: "x", line: 1 }), commentId: 100, firstSeenSha: "h1", lastSeenSha: "h1" };
    const prior = mkReport({ headSha: "h1", findings: [oldFinding] });
    // Same logical issue, line shifted to 5.
    const movedRaw = mkFinding({ ruleId: "r", path: "a.ts", message: "x", line: 5 });
    const movedFinding = { ...movedRaw, priorFp: oldFinding.fingerprint };
    const cur = mkReport({ headSha: "h2", findings: [movedFinding] });
    const plan = buildActionPlan(prior, cur);
    expect(plan.patchesMoved).toHaveLength(1);
    expect(plan.patchesMoved[0]?.commentId).toBe(100);
    expect(plan.patchesMoved[0]?.priorFp).toBe(oldFinding.fingerprint);
    expect(plan.patchesMoved[0]?.finding.line).toBe(5);
    expect(plan.outputFindings).toHaveLength(1);
    expect(plan.outputFindings[0]?.commentId).toBe(100);
    expect(plan.outputFindings[0]?.firstSeenSha).toBe("h1");
    expect(plan.outputFindings[0]?.lastSeenSha).toBe("h2");
    expect(plan.posts).toEqual([]);
  });

  it("net-new finding — POSTs and stamps firstSeenSha/lastSeenSha", () => {
    const old = { ...mkFinding({ ruleId: "r", path: "a.ts", message: "x", line: 1 }), commentId: 100, firstSeenSha: "h1", lastSeenSha: "h1" };
    const prior = mkReport({ headSha: "h1", findings: [old] });
    const newFinding = mkFinding({ ruleId: "r", path: "b.ts", message: "z", line: 1 });
    const cur = mkReport({ headSha: "h2", findings: [newFinding] });
    const plan = buildActionPlan(prior, cur);
    expect(plan.posts).toHaveLength(1);
    expect(plan.posts[0]?.firstSeenSha).toBe("h2");
    // Output: net-new + carry-forward of `old`.
    expect(plan.outputFindings).toHaveLength(2);
    const carried = plan.outputFindings.find((f) => f.fingerprint === old.fingerprint);
    expect(carried?.commentId).toBe(100);
    expect(carried?.lastSeenSha).toBe("h2");
  });

  it("mixed run — resolution + moved + new + carry-forward all play together", () => {
    const fResolved = { ...mkFinding({ ruleId: "r", path: "a.ts", message: "resolved", line: 1 }), commentId: 1, firstSeenSha: "h1", lastSeenSha: "h1" };
    const fMoved = { ...mkFinding({ ruleId: "r", path: "b.ts", message: "moved", line: 10 }), commentId: 2, firstSeenSha: "h1", lastSeenSha: "h1" };
    const fStill = { ...mkFinding({ ruleId: "r", path: "c.ts", message: "still", line: 3 }), commentId: 3, firstSeenSha: "h1", lastSeenSha: "h1" };
    const prior = mkReport({ headSha: "h1", findings: [fResolved, fMoved, fStill] });

    const movedNew = { ...mkFinding({ ruleId: "r", path: "b.ts", message: "moved", line: 22 }), priorFp: fMoved.fingerprint };
    const newF = mkFinding({ ruleId: "r", path: "d.ts", message: "new", line: 1 });
    const cur = mkReport({
      headSha: "h2",
      findings: [movedNew, newF],
      resolutions: [{ ruleId: "r", fingerprint: fResolved.fingerprint, reason: "fixed", resolvedAtSha: "h2" }],
    });
    const plan = buildActionPlan(prior, cur);

    expect(plan.patchesResolved).toHaveLength(1);
    expect(plan.patchesResolved[0]?.commentId).toBe(1);
    expect(plan.patchesMoved).toHaveLength(1);
    expect(plan.patchesMoved[0]?.commentId).toBe(2);
    expect(plan.posts).toHaveLength(1);
    expect(plan.posts[0]?.message).toBe("new");

    // Output: moved (with new line) + still (carry-forward) + new. Resolved is dropped.
    expect(plan.outputFindings).toHaveLength(3);
    const ids = plan.outputFindings.map((f) => f.commentId).sort();
    expect(ids).toEqual([2, 3, undefined]);
  });

  it("resolution without commentId in prior — silently skipped (no PATCH possible)", () => {
    const f = { ...mkFinding({ ruleId: "r", path: "a.ts", message: "x", line: 1 }), firstSeenSha: "h1", lastSeenSha: "h1" }; // no commentId
    const prior = mkReport({ headSha: "h1", findings: [f] });
    const cur = mkReport({
      headSha: "h2",
      findings: [],
      resolutions: [{ ruleId: "r", fingerprint: f.fingerprint, reason: "fixed", resolvedAtSha: "h2" }],
    });
    const plan = buildActionPlan(prior, cur);
    expect(plan.patchesResolved).toEqual([]);
    expect(plan.outputFindings).toEqual([]);
  });

  it("resolution referencing unknown prior fingerprint — ignored", () => {
    const cur = mkReport({
      headSha: "h2",
      findings: [],
      resolutions: [{ ruleId: "r", fingerprint: "ghost00000000", reason: "fixed", resolvedAtSha: "h2" }],
    });
    const plan = buildActionPlan(undefined, cur);
    expect(plan.patchesResolved).toEqual([]);
  });
});
