import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitHubForgeAdapter } from "../../src/forges/github/index.js";
import { computeFingerprint } from "../../src/findings.js";
import type { RunReport } from "../../src/types.js";

const findingInDiff = {
  ruleId: "dead-code",
  severity: "high" as const,
  path: "src/foo.ts",
  line: 2,
  message: "in diff",
};
const findingOutOfDiff = {
  ruleId: "dead-code",
  severity: "low" as const,
  path: "src/foo.ts",
  line: 99,
  message: "out of diff",
};

const REPORT: RunReport = {
  schemaVersion: 2,
  runId: "00000000-0000-0000-0000-000000000000",
  startedAt: new Date(0).toISOString(),
  completedAt: new Date(1).toISOString(),
  reviewTarget: {
    target: { mode: "ref-range", base: "main", head: "HEAD" },
    baseSha: "b".repeat(40),
    headSha: "h".repeat(40),
    changedFiles: ["src/foo.ts"],
    mode: "ref-range",
  },
  rules: [
    { id: "dead-code", path: ".revu/dead-code.revu.md", ok: true, durationMs: 10, findingCount: 2 },
  ],
  findings: [
    { ...findingInDiff, fingerprint: computeFingerprint(findingInDiff) },
    { ...findingOutOfDiff, fingerprint: computeFingerprint(findingOutOfDiff) },
  ],
  resolutions: [],
};

const FAKE_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index 1..2 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,1 +1,3 @@
 unchanged
+new-line-2
+new-line-3
`;

interface CallLog {
  url: string;
  method: string;
  body?: unknown;
}

interface MockOptions {
  /** Comments returned by GET /reviews/{id}/comments after a review is created. */
  reviewCommentsForReview?: Array<{ id: number; body: string }>;
  patchResponse?: (commentId: number, body: { body: string }) => unknown;
  /** When true, the diff fetch (GET /pulls/{n} with vnd.github.v3.diff) returns
   *  GitHub's "too_large" 406 — simulates PRs whose diff exceeds 20k lines. */
  diffTooLarge?: boolean;
}

function makeFetch(opts: MockOptions = {}): { fetchImpl: typeof fetch; calls: CallLog[] } {
  const calls: CallLog[] = [];

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const method = init?.method ?? "GET";
    const accept = (init?.headers as Record<string, string> | undefined)?.["Accept"] ?? "";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method, ...(body ? { body } : {}) });

    const respond = (status: number, payload: unknown) =>
      ({
        ok: status >= 200 && status < 300,
        status,
        text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
      }) as unknown as Response;

    if (method === "GET" && /\/reviews\/\d+\/comments/.test(url)) {
      return respond(200, opts.reviewCommentsForReview ?? []);
    }
    if (method === "GET" && url.includes("/pulls/") && accept.includes("vnd.github.v3.diff")) {
      if (opts.diffTooLarge) {
        return respond(406, {
          message: "Sorry, the diff exceeded the maximum number of lines (20000)",
          errors: [{ resource: "PullRequest", field: "diff", code: "too_large" }],
          status: "406",
        });
      }
      return respond(200, FAKE_DIFF);
    }
    if (method === "GET" && url.includes("/pulls/")) {
      return respond(200, {
        number: 42,
        head: { sha: "h".repeat(40), ref: "feature" },
        base: { sha: "b".repeat(40), ref: "main" },
      });
    }
    if (method === "POST" && url.endsWith("/reviews")) {
      return respond(201, { id: 999, html_url: "https://github.com/o/r/pull/42#review", state: "COMMENTED" });
    }
    if (method === "PATCH" && /\/pulls\/comments\/\d+/.test(url)) {
      const m = url.match(/\/pulls\/comments\/(\d+)/);
      const id = m?.[1] ? Number(m[1]) : 0;
      return respond(200, opts.patchResponse?.(id, body as { body: string }) ?? { id, body: (body as { body: string }).body });
    }
    return respond(404, { message: "unhandled" });
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

const CONTEXT = {
  repo: { owner: "o", name: "r" },
  pr: 42,
  headSha: "h".repeat(40),
  baseSha: "b".repeat(40),
  token: "t",
};

beforeEach(() => {
  vi.unstubAllEnvs();
});

describe("GitHubForgeAdapter.post", () => {
  it("first run (no prior) — POSTs a single bundled review with one inline + body, no PATCHes", async () => {
    const inlineFinding = REPORT.findings[0];
    if (!inlineFinding) throw new Error("fixture");
    const { fetchImpl, calls } = makeFetch({
      reviewCommentsForReview: [
        // Server replies with the freshly-created comment carrying the same fingerprint marker.
        { id: 5001, body: `body with marker <!-- revu-ai:fp=${inlineFinding.fingerprint} -->` },
      ],
    });
    const adapter = new GitHubForgeAdapter(fetchImpl);

    const result = await adapter.post({
      report: REPORT,
      context: CONTEXT,
      dryRun: false,
    });

    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/reviews"));
    expect(post).toBeDefined();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);

    const reviewBody = post?.body as { commit_id: string; event: string; body: string; comments: unknown[] };
    expect(reviewBody.commit_id).toBe("h".repeat(40));
    expect(reviewBody.event).toBe("COMMENT");
    expect(reviewBody.comments).toHaveLength(1);
    expect((reviewBody.comments[0] as { line: number }).line).toBe(2);
    expect(reviewBody.body).toContain("out of diff");

    expect(result.event).toBe("comment");
    expect(result.inline.posted).toBe(1);
    expect(result.body.posted).toBe(1);
    expect(result.patchesResolved).toBe(0);
    expect(result.patchesMoved).toBe(0);
    expect(result.reviewUrl).toBe("https://github.com/o/r/pull/42#review");

    // The augmentedReport should have commentId populated on the inline finding.
    const inlineAug = result.augmentedReport.findings.find((f) => f.line === 2);
    expect(inlineAug?.commentId).toBe(5001);
  });

  it("REQUEST_CHANGES when --request-changes threshold is crossed", async () => {
    const { fetchImpl, calls } = makeFetch();
    const adapter = new GitHubForgeAdapter(fetchImpl);
    await adapter.post({
      report: REPORT,
      context: CONTEXT,
      requestChangesAtOrAbove: "high",
      dryRun: false,
    });
    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/reviews"));
    expect((post?.body as { event: string }).event).toBe("REQUEST_CHANGES");
  });

  it("dry-run makes zero network calls", async () => {
    const { fetchImpl, calls } = makeFetch();
    const adapter = new GitHubForgeAdapter(fetchImpl);
    await adapter.post({ report: REPORT, context: CONTEXT, dryRun: true });
    expect(calls).toEqual([]);
  });

  it("falls back gracefully when GitHub returns 406 'too_large' for the PR diff (>20k lines)", async () => {
    const { fetchImpl, calls } = makeFetch({ diffTooLarge: true });
    const adapter = new GitHubForgeAdapter(fetchImpl);

    const result = await adapter.post({
      report: REPORT,
      context: CONTEXT,
      dryRun: false,
    });

    // The review still goes out — no exception thrown.
    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/reviews"));
    expect(post).toBeDefined();
    expect(result.event).toBe("comment");

    // With no diff parsable, every finding routes to the top-level body
    // (out-of-diff section) instead of inline. The two findings in the
    // fixture both end up there.
    const reviewBody = post?.body as { comments: unknown[]; body: string };
    expect(reviewBody.comments).toEqual([]);
    expect(reviewBody.body).toContain("in diff");
    expect(reviewBody.body).toContain("out of diff");
    expect(result.inline.posted).toBe(0);
  });

  it("with prior — resolved finding triggers PATCH-strikethrough, no POST", async () => {
    const inline = REPORT.findings[0];
    if (!inline) throw new Error("fixture");
    const priorReport: RunReport = {
      ...REPORT,
      findings: [{ ...inline, commentId: 100, firstSeenSha: "h0", lastSeenSha: "h0" }],
    };
    const currentReport: RunReport = {
      ...REPORT,
      findings: [],
      resolutions: [
        { ruleId: "dead-code", fingerprint: inline.fingerprint, reason: "fixed", resolvedAtSha: "h".repeat(40) },
      ],
    };
    const { fetchImpl, calls } = makeFetch();
    const adapter = new GitHubForgeAdapter(fetchImpl);
    const result = await adapter.post({
      report: currentReport,
      priorReport,
      context: CONTEXT,
      dryRun: false,
    });
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch).toBeDefined();
    expect(patch?.url).toContain("/pulls/comments/100");
    const patchBody = (patch?.body as { body: string }).body;
    expect(patchBody).toContain("Marked resolved by revu-ai");
    expect(patchBody).toContain("~~");
    // No POST because there are no new findings.
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(result.patchesResolved).toBe(1);
    expect(result.patchesMoved).toBe(0);
    // outputFindings drops the resolved finding.
    expect(result.augmentedReport.findings).toEqual([]);
  });

  it("with prior — moved finding (priorFp set) triggers PATCH-update, no fresh POST", async () => {
    const oldF = REPORT.findings[0];
    if (!oldF) throw new Error("fixture");
    const priorReport: RunReport = {
      ...REPORT,
      findings: [{ ...oldF, commentId: 200, firstSeenSha: "h0", lastSeenSha: "h0" }],
    };
    const movedRaw = { ...findingInDiff, line: 3 }; // line shifted from 2 to 3
    const movedFinding = {
      ...movedRaw,
      fingerprint: computeFingerprint(movedRaw),
      priorFp: oldF.fingerprint,
    };
    const currentReport: RunReport = {
      ...REPORT,
      findings: [movedFinding],
      resolutions: [],
    };
    const { fetchImpl, calls } = makeFetch();
    const adapter = new GitHubForgeAdapter(fetchImpl);
    const result = await adapter.post({
      report: currentReport,
      priorReport,
      context: CONTEXT,
      dryRun: false,
    });
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch).toBeDefined();
    expect(patch?.url).toContain("/pulls/comments/200");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(result.patchesMoved).toBe(1);
    expect(result.patchesResolved).toBe(0);
    // outputFindings carries forward the commentId on the moved finding.
    const aug = result.augmentedReport.findings[0];
    expect(aug?.commentId).toBe(200);
    expect(aug?.line).toBe(3);
    expect(aug?.firstSeenSha).toBe("h0");
  });

  it("with prior — net-new finding alongside a resolved one: 1 PATCH + 1 POST", async () => {
    const oldF = REPORT.findings[0];
    if (!oldF) throw new Error("fixture");
    const priorReport: RunReport = {
      ...REPORT,
      findings: [{ ...oldF, commentId: 300, firstSeenSha: "h0", lastSeenSha: "h0" }],
    };
    const newRaw = { ruleId: "dead-code", severity: "high" as const, path: "src/foo.ts", line: 3, message: "fresh" };
    const newFinding = { ...newRaw, fingerprint: computeFingerprint(newRaw) };
    const currentReport: RunReport = {
      ...REPORT,
      findings: [newFinding],
      resolutions: [
        { ruleId: "dead-code", fingerprint: oldF.fingerprint, reason: "fixed", resolvedAtSha: "h".repeat(40) },
      ],
    };
    const { fetchImpl, calls } = makeFetch({
      reviewCommentsForReview: [
        { id: 6001, body: `body <!-- revu-ai:fp=${newFinding.fingerprint} -->` },
      ],
    });
    const adapter = new GitHubForgeAdapter(fetchImpl);
    const result = await adapter.post({
      report: currentReport,
      priorReport,
      context: CONTEXT,
      dryRun: false,
    });
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
    expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/reviews"))).toHaveLength(1);
    expect(result.patchesResolved).toBe(1);
    expect(result.inline.posted).toBe(1);
    // Resolved finding is gone from outputFindings; new finding carries its newly-allocated commentId.
    expect(result.augmentedReport.findings).toHaveLength(1);
    expect(result.augmentedReport.findings[0]?.commentId).toBe(6001);
  });

  it("replay (no plan changes) — zero PATCHes, zero POSTs", async () => {
    const inline = REPORT.findings[0];
    if (!inline) throw new Error("fixture");
    const priorReport: RunReport = {
      ...REPORT,
      findings: [{ ...inline, commentId: 700, firstSeenSha: "h0", lastSeenSha: "h0" }],
    };
    // Current run has no findings (agent stayed silent because still-open) and no resolutions.
    const currentReport: RunReport = { ...REPORT, findings: [], resolutions: [] };
    const { fetchImpl, calls } = makeFetch();
    const adapter = new GitHubForgeAdapter(fetchImpl);
    const result = await adapter.post({
      report: currentReport,
      priorReport,
      context: CONTEXT,
      dryRun: false,
    });
    expect(calls).toEqual([]);
    expect(result.patchesResolved).toBe(0);
    expect(result.patchesMoved).toBe(0);
    expect(result.inline.posted).toBe(0);
    // outputFindings preserves the open prior with bumped lastSeenSha.
    expect(result.augmentedReport.findings).toHaveLength(1);
    expect(result.augmentedReport.findings[0]?.commentId).toBe(700);
  });
});

describe("GitHubForgeAdapter.resolveContext", () => {
  it("resolves from $GITHUB_REPOSITORY + $GITHUB_REF + $GITHUB_SHA + $GITHUB_TOKEN", async () => {
    const adapter = new GitHubForgeAdapter();
    const env = {
      GITHUB_TOKEN: "t",
      GITHUB_REPOSITORY: "o/r",
      GITHUB_REF: "refs/pull/77/merge",
      GITHUB_SHA: "deadbeef",
    } as NodeJS.ProcessEnv;
    const ctx = await adapter.resolveContext(env, {});
    expect(ctx).toMatchObject({
      repo: { owner: "o", name: "r" },
      pr: 77,
      headSha: "deadbeef",
      token: "t",
    });
  });

  it("CLI flags override env", async () => {
    const adapter = new GitHubForgeAdapter();
    const env = {
      GITHUB_TOKEN: "t",
      GITHUB_REPOSITORY: "o/r",
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: "x",
    } as NodeJS.ProcessEnv;
    const ctx = await adapter.resolveContext(env, { pr: "5", repo: "p/q", commitSha: "y" });
    expect(ctx.repo).toEqual({ owner: "p", name: "q" });
    expect(ctx.pr).toBe(5);
    expect(ctx.headSha).toBe("y");
  });

  it("throws when token is missing", async () => {
    const adapter = new GitHubForgeAdapter();
    await expect(
      adapter.resolveContext({ GITHUB_REPOSITORY: "o/r", GITHUB_REF: "refs/pull/1/merge" }, {}),
    ).rejects.toThrow(/no token in \$GITHUB_TOKEN/);
  });

  it("throws when PR cannot be resolved", async () => {
    const adapter = new GitHubForgeAdapter();
    await expect(
      adapter.resolveContext({ GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "o/r" }, {}),
    ).rejects.toThrow(/PR number not found/);
  });
});
