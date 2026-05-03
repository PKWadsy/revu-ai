import { readFileSync } from "node:fs";
import { SEVERITY_ORDER } from "../../types.js";
import type { Finding, RunReport, Severity } from "../../types.js";
import { buildActionPlan } from "../../cache/cross-reference.js";
import { extractMarkers } from "../dedup.js";
import { isInlineable, parseUnifiedDiff } from "../diff-lines.js";
import { renderCommentBody, renderTopLevelBody } from "../render.js";
import type {
  ForgeAdapter,
  ForgeAdapterFactory,
  ForgeContext,
  PostOptions,
  PostResult,
  ResolveContextFlags,
} from "../types.js";
import { GitHubClient, type GhPostReviewBody } from "./api.js";

export const githubForgeFactory: ForgeAdapterFactory = () => new GitHubForgeAdapter();

export class GitHubForgeAdapter implements ForgeAdapter {
  readonly name = "github";

  /** Allow tests to inject a custom `fetch`. */
  constructor(private readonly fetchImpl?: typeof fetch) {}

  async resolveContext(
    env: NodeJS.ProcessEnv,
    flags: ResolveContextFlags,
  ): Promise<ForgeContext> {
    const tokenEnv = flags.tokenEnv ?? "GITHUB_TOKEN";
    const token = env[tokenEnv];
    if (!token) {
      throw new Error(
        `GitHub: no token in $${tokenEnv}. Set it (\`permissions: pull-requests: write\` exposes \$GITHUB_TOKEN in Actions).`,
      );
    }

    const repoStr = flags.repo ?? env["GITHUB_REPOSITORY"];
    if (!repoStr || !repoStr.includes("/")) {
      throw new Error(
        "GitHub: repo not found. Set $GITHUB_REPOSITORY (owner/name) or pass --repo owner/name.",
      );
    }
    const [owner, name] = repoStr.split("/", 2) as [string, string];

    const pr = resolvePrNumber(flags.pr, env);
    if (pr === undefined) {
      throw new Error(
        "GitHub: PR number not found. Set $GITHUB_REF (refs/pull/<n>/...) or pass --pr <n>.",
      );
    }

    let headSha = flags.commitSha ?? env["GITHUB_SHA"];
    let baseSha: string | undefined;
    if (!headSha) {
      // Fall back to the PR's head SHA from the API.
      const client = new GitHubClient(token, this.fetchImpl);
      const pull = await client.getPullRequest(owner, name, pr);
      headSha = pull.head.sha;
      baseSha = pull.base.sha;
    }

    return {
      repo: { owner, name },
      pr,
      headSha,
      ...(baseSha ? { baseSha } : {}),
      token,
    };
  }

  async post(options: PostOptions): Promise<PostResult> {
    const { context, report, priorReport } = options;
    const client = new GitHubClient(context.token, this.fetchImpl);

    // Build the (priorReport, currentReport) → action plan.
    const plan = buildActionPlan(priorReport, report);

    // Compute event from the *new* posts (PR check stickiness story is documented in the README).
    const ghEvent = computeEvent(plan.posts, options.requestChangesAtOrAbove);
    const event = ghEventToAgnostic(ghEvent);

    const totalFindings = plan.outputFindings.length;

    // Short-circuit: nothing to do.
    if (plan.posts.length === 0 && plan.patchesResolved.length === 0 && plan.patchesMoved.length === 0) {
      const augmented = augmentReport(report, plan.outputFindings, plan.outputResolutions);
      if (options.dryRun) {
        process.stdout.write(`[dry-run] no PATCH or POST work to do (no plan changes)\n`);
      }
      return {
        inline: { posted: 0, skipped: 0 },
        body: { posted: 0, skipped: 1 },
        patchesResolved: 0,
        patchesMoved: 0,
        totalFindings,
        event,
        augmentedReport: augmented,
      };
    }

    // Fetch the PR diff so we know which lines are inline-postable.
    const diff = !options.dryRun
      ? await client.getPullRequestDiff(context.repo.owner, context.repo.name, context.pr)
      : "";
    const diffMap = parseUnifiedDiff(diff);

    // Partition fresh posts into inline-eligible vs out-of-diff.
    const inline: Finding[] = [];
    const outOfDiff: Finding[] = [];
    for (const f of plan.posts) {
      if (f.line !== undefined && isInlineable(diffMap, f.path, f.line)) inline.push(f);
      else outOfDiff.push(f);
    }

    // Build the inline comments[] payload (single bundled review).
    const comments: GhPostReviewBody["comments"] = inline.map((f) => {
      const line = f.line as number;
      const lineEnd = f.lineEnd && f.lineEnd > line && isInlineable(diffMap, f.path, f.lineEnd) ? f.lineEnd : undefined;
      return lineEnd
        ? {
            path: f.path,
            line: lineEnd,
            side: "RIGHT" as const,
            body: renderCommentBody(f),
            start_line: line,
            start_side: "RIGHT" as const,
          }
        : {
            path: f.path,
            line,
            side: "RIGHT" as const,
            body: renderCommentBody(f),
          };
    });

    const totalNew = plan.posts.length;
    const bodyText = renderTopLevelBody(
      {
        total: totalNew + plan.patchesResolved.length + plan.patchesMoved.length,
        newCount: totalNew,
        alreadyPosted: plan.patchesMoved.length,
        outOfDiff: outOfDiff.length,
      },
      outOfDiff,
    );

    const reviewBody: GhPostReviewBody = {
      commit_id: context.headSha,
      event: ghEvent,
      body: bodyText,
      comments,
    };

    if (options.dryRun) {
      printDryRun({
        url: `https://api.github.com/repos/${context.repo.owner}/${context.repo.name}/pulls/${context.pr}/reviews`,
        reviewBody,
        plan: {
          patchesResolved: plan.patchesResolved.length,
          patchesMoved: plan.patchesMoved.length,
          posts: plan.posts.length,
          outOfDiff: outOfDiff.length,
        },
      });
      const augmented = augmentReport(report, plan.outputFindings, plan.outputResolutions);
      return {
        inline: { posted: comments.length, skipped: 0 },
        body: { posted: comments.length + outOfDiff.length > 0 ? 1 : 0, skipped: 0 },
        patchesResolved: plan.patchesResolved.length,
        patchesMoved: plan.patchesMoved.length,
        totalFindings,
        event,
        augmentedReport: augmented,
      };
    }

    // ---- Execute PATCHes (sequential to keep error handling simple) ----
    const shortSha = context.headSha.slice(0, 7);
    const today = new Date().toISOString().slice(0, 10);

    for (const p of plan.patchesResolved) {
      const original = renderCommentBody(p.finding);
      const wrappedBody = wrapResolved(original, shortSha, today, p.reason);
      await client.patchReviewComment(
        context.repo.owner,
        context.repo.name,
        Number(p.commentId),
        { body: wrappedBody },
      );
    }
    for (const p of plan.patchesMoved) {
      const newBody = renderCommentBody(p.finding);
      await client.patchReviewComment(
        context.repo.owner,
        context.repo.name,
        Number(p.commentId),
        { body: newBody },
      );
    }

    // ---- POST a bundled review for new findings (if any) ----
    let reviewUrl: string | undefined;
    const bodyPosted = inline.length > 0 || outOfDiff.length > 0;
    if (bodyPosted) {
      const created = await client.createReview(context.repo.owner, context.repo.name, context.pr, reviewBody);
      reviewUrl = created.html_url;

      // Match new comments to their freshly-allocated GitHub ids by fingerprint marker.
      if (inline.length > 0) {
        const created_comments = await client.listReviewCommentsForReview(
          context.repo.owner,
          context.repo.name,
          context.pr,
          created.id,
        );
        const fpToId = new Map<string, number>();
        for (const c of created_comments) {
          for (const fp of extractMarkers(c.body)) fpToId.set(fp, c.id);
        }
        for (const f of plan.outputFindings) {
          if (f.commentId !== undefined) continue;
          const id = fpToId.get(f.fingerprint);
          if (id !== undefined) f.commentId = id;
        }
      }
    }

    const augmented = augmentReport(report, plan.outputFindings, plan.outputResolutions);

    return {
      ...(reviewUrl ? { reviewUrl } : {}),
      inline: { posted: inline.length, skipped: 0 },
      body: { posted: bodyPosted ? 1 : 0, skipped: 0 },
      patchesResolved: plan.patchesResolved.length,
      patchesMoved: plan.patchesMoved.length,
      totalFindings,
      event,
      augmentedReport: augmented,
    };
  }
}

function augmentReport(report: RunReport, outputFindings: Finding[], outputResolutions: RunReport["resolutions"]): RunReport {
  return {
    ...report,
    findings: outputFindings,
    resolutions: outputResolutions,
  };
}

/** Wrap a comment body with strikethrough + a footer noting the resolution. */
function wrapResolved(originalBody: string, shortSha: string, isoDate: string, reason: "fixed" | "stale"): string {
  const stripped = originalBody.replace(/<!--[\s\S]*?-->/g, "").trim();
  const struck = stripped
    .split("\n")
    .map((line) => (line.length === 0 ? "" : `~~${line}~~`))
    .join("\n");
  const reasonText = reason === "stale" ? "no longer applicable" : "addressed by the new commits";
  return `${struck}\n\n✅ **Marked resolved by revu-ai** at \`${shortSha}\` on ${isoDate} — ${reasonText}.`;
}

/** Compute the GitHub-native review event. */
function computeEvent(findings: Finding[], threshold?: Severity): "COMMENT" | "REQUEST_CHANGES" {
  if (!threshold) return "COMMENT";
  const t = SEVERITY_ORDER[threshold];
  return findings.some((f) => SEVERITY_ORDER[f.severity] >= t) ? "REQUEST_CHANGES" : "COMMENT";
}

function ghEventToAgnostic(e: "COMMENT" | "REQUEST_CHANGES" | "APPROVE"): "comment" | "request-changes" | "approve" {
  switch (e) {
    case "COMMENT":
      return "comment";
    case "REQUEST_CHANGES":
      return "request-changes";
    case "APPROVE":
      return "approve";
  }
}

/** Resolve the PR number from --pr / $GITHUB_REF / $GITHUB_EVENT_PATH (in that order). */
function resolvePrNumber(prFlag: string | undefined, env: NodeJS.ProcessEnv): number | undefined {
  if (prFlag) {
    const n = Number.parseInt(prFlag, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const ref = env["GITHUB_REF"];
  if (ref) {
    const m = ref.match(/^refs\/pull\/(\d+)\//);
    if (m && m[1]) return Number.parseInt(m[1], 10);
  }
  const eventPath = env["GITHUB_EVENT_PATH"];
  if (eventPath) {
    try {
      const event = JSON.parse(readFileSync(eventPath, "utf8")) as {
        pull_request?: { number?: number };
        number?: number;
      };
      if (typeof event.pull_request?.number === "number") return event.pull_request.number;
      if (typeof event.number === "number") return event.number;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

interface DryRunInfo {
  url: string;
  reviewBody: GhPostReviewBody;
  plan: { patchesResolved: number; patchesMoved: number; posts: number; outOfDiff: number };
}

function printDryRun(info: DryRunInfo): void {
  process.stdout.write(
    `[dry-run] plan: PATCHes-resolved=${info.plan.patchesResolved}, PATCHes-moved=${info.plan.patchesMoved}, POSTs=${info.plan.posts}, out-of-diff=${info.plan.outOfDiff}\n`,
  );
  if (info.plan.posts > 0 || info.plan.outOfDiff > 0) {
    process.stdout.write(`[dry-run] POST ${info.url}\n`);
    process.stdout.write(JSON.stringify(info.reviewBody, null, 2) + "\n");
  }
}
