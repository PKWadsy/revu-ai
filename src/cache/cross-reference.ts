import type { Finding, Resolution, RunReport } from "../types.js";

/**
 * Pure function that turns a (priorReport, currentReport) pair into a plan
 * of what the post step should do on the forge:
 *  - PATCH comments for resolved findings (mark them resolved-with-strikethrough)
 *  - PATCH comments for moved findings (rewrite body + line)
 *  - POST fresh comments for genuinely-new findings
 *  - Produce the next-run cache (`outputFindings` ∪ resolved entries)
 */
export interface ResolvedPatch {
  ruleId: string;
  commentId: number | string;
  /** The finding (from prior) being marked resolved. */
  finding: Finding;
  reason: "fixed" | "stale";
  resolvedAtSha: string;
}

export interface MovedPatch {
  ruleId: string;
  commentId: number | string;
  /** The finding (from current run) at its new location. */
  finding: Finding;
  /** The fingerprint of the prior finding this evolved from. */
  priorFp: string;
}

export interface ActionPlan {
  patchesResolved: ResolvedPatch[];
  patchesMoved: MovedPatch[];
  posts: Finding[];
  /** Findings to record in the cache for the next run. Includes still-open carry-overs,
   *  moved-to-new-location updates, and net-new findings. Resolved findings are NOT
   *  carried forward (their resolution is final). */
  outputFindings: Finding[];
  /** Resolutions from the current run, plus any prior resolutions carried over. */
  outputResolutions: Resolution[];
}

export function buildActionPlan(
  priorReport: RunReport | undefined,
  currentReport: RunReport,
): ActionPlan {
  const currentSha = currentReport.reviewTarget.headSha ?? "";

  // ---- Index prior findings by fingerprint ----
  const priorByFp = new Map<string, Finding>();
  if (priorReport) {
    for (const f of priorReport.findings) {
      priorByFp.set(f.fingerprint, f);
    }
  }

  // ---- Track which prior fps are touched this run ----
  const touchedPriorFps = new Set<string>();

  // ---- Walk current resolutions ----
  const patchesResolved: ResolvedPatch[] = [];
  for (const r of currentReport.resolutions) {
    const prior = priorByFp.get(r.fingerprint);
    if (!prior) continue; // resolution refers to an unknown prior — ignore (could be stale agent state)
    touchedPriorFps.add(r.fingerprint);
    if (prior.commentId !== undefined) {
      patchesResolved.push({
        ruleId: r.ruleId,
        commentId: prior.commentId,
        finding: prior,
        reason: r.reason,
        resolvedAtSha: r.resolvedAtSha || currentSha,
      });
    }
  }

  // ---- Walk current findings ----
  const patchesMoved: MovedPatch[] = [];
  const posts: Finding[] = [];
  const outputFindings: Finding[] = [];

  for (const cf of currentReport.findings) {
    if (cf.priorFp) {
      // Moved finding — correlate with the prior.
      const prior = priorByFp.get(cf.priorFp);
      touchedPriorFps.add(cf.priorFp);
      if (prior?.commentId !== undefined) {
        const augmented: Finding = {
          ...cf,
          commentId: prior.commentId,
          firstSeenSha: prior.firstSeenSha ?? prior.lastSeenSha ?? currentSha,
          lastSeenSha: currentSha,
        };
        patchesMoved.push({
          ruleId: cf.ruleId,
          commentId: prior.commentId,
          finding: augmented,
          priorFp: cf.priorFp,
        });
        outputFindings.push(augmented);
        continue;
      }
      // Prior we'd patch isn't known — treat as a fresh post.
      posts.push({ ...cf, firstSeenSha: currentSha, lastSeenSha: currentSha });
      outputFindings.push({ ...cf, firstSeenSha: currentSha, lastSeenSha: currentSha });
      continue;
    }

    const samePrior = priorByFp.get(cf.fingerprint);
    if (samePrior) {
      // Still open at the same location — carry the prior commentId forward.
      touchedPriorFps.add(cf.fingerprint);
      outputFindings.push({
        ...cf,
        commentId: samePrior.commentId,
        firstSeenSha: samePrior.firstSeenSha ?? samePrior.lastSeenSha ?? currentSha,
        lastSeenSha: currentSha,
      });
      continue;
    }

    // Genuinely new.
    posts.push({ ...cf, firstSeenSha: currentSha, lastSeenSha: currentSha });
    outputFindings.push({ ...cf, firstSeenSha: currentSha, lastSeenSha: currentSha });
  }

  // ---- Carry forward prior findings that weren't touched and weren't resolved ----
  // The reviewer agent is *expected* to silently drop "still open at same location" findings.
  // If a prior is missing from current AND not in resolutions, treat as still-open and carry over.
  if (priorReport) {
    for (const prior of priorReport.findings) {
      if (touchedPriorFps.has(prior.fingerprint)) continue;
      // Already-resolved (in this run) is a different bucket — handled above.
      // Carry forward unchanged with lastSeenSha bumped.
      outputFindings.push({
        ...prior,
        lastSeenSha: currentSha,
      });
    }
  }

  // ---- Resolutions: just propagate this run's; old resolutions don't need re-recording. ----
  const outputResolutions: Resolution[] = [...currentReport.resolutions];

  return { patchesResolved, patchesMoved, posts, outputFindings, outputResolutions };
}
