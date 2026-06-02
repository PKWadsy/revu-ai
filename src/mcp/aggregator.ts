import { SEVERITIES, type Check, type Finding, type Resolution, type ReviewSummary, type Severity } from "../types.js";

export class FindingsAggregator {
  private byRule = new Map<string, Finding[]>();
  private dedupKeys = new Set<string>();
  private listeners = new Set<(f: Finding) => void>();
  private resolutionsByRule = new Map<string, Resolution[]>();
  private resolutionDedupKeys = new Set<string>();
  private resolutionListeners = new Set<(r: Resolution) => void>();
  private summaryByRule = new Map<string, ReviewSummary>();
  private summaryListeners = new Set<(s: ReviewSummary) => void>();
  /** ruleId -> set of prior fingerprints the agent explicitly confirmed still-open. */
  private openByRule = new Map<string, Set<string>>();
  private checksByRule = new Map<string, Check[]>();
  private checkDedupKeys = new Set<string>();
  private checkListeners = new Set<(c: Check) => void>();

  onAdd(listener: (f: Finding) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onResolution(listener: (r: Resolution) => void): () => void {
    this.resolutionListeners.add(listener);
    return () => this.resolutionListeners.delete(listener);
  }

  onSummary(listener: (s: ReviewSummary) => void): () => void {
    this.summaryListeners.add(listener);
    return () => this.summaryListeners.delete(listener);
  }

  onCheck(listener: (c: Check) => void): () => void {
    this.checkListeners.add(listener);
    return () => this.checkListeners.delete(listener);
  }

  add(finding: Finding): boolean {
    const key = `${finding.ruleId}\0${finding.severity}\0${finding.path}\0${finding.line ?? ""}\0${finding.lineEnd ?? ""}\0${finding.message}`;
    if (this.dedupKeys.has(key)) return false;
    this.dedupKeys.add(key);

    const list = this.byRule.get(finding.ruleId);
    if (list) list.push(finding);
    else this.byRule.set(finding.ruleId, [finding]);
    for (const l of this.listeners) {
      try { l(finding); } catch { /* listener errors must not affect aggregation */ }
    }
    return true;
  }

  /** Record that a prior finding was resolved by the agent. */
  markResolved(ruleId: string, fingerprint: string, reason: "fixed" | "stale", resolvedAtSha = ""): boolean {
    const key = `${ruleId}\0${fingerprint}`;
    if (this.resolutionDedupKeys.has(key)) return false;
    this.resolutionDedupKeys.add(key);

    const resolution: Resolution = { ruleId, fingerprint, reason, resolvedAtSha };
    const list = this.resolutionsByRule.get(ruleId);
    if (list) list.push(resolution);
    else this.resolutionsByRule.set(ruleId, [resolution]);
    for (const l of this.resolutionListeners) {
      try { l(resolution); } catch { /* listener errors must not affect aggregation */ }
    }
    return true;
  }

  /** Record that a prior finding is still open at the same location. Idempotent per fingerprint. */
  markOpen(ruleId: string, fingerprint: string): boolean {
    let set = this.openByRule.get(ruleId);
    if (!set) {
      set = new Set();
      this.openByRule.set(ruleId, set);
    }
    if (set.has(fingerprint)) return false;
    set.add(fingerprint);
    return true;
  }

  countFor(ruleId: string): number {
    return this.byRule.get(ruleId)?.length ?? 0;
  }

  findingsFor(ruleId: string): Finding[] {
    return this.byRule.get(ruleId) ?? [];
  }

  resolutionsFor(ruleId: string): Resolution[] {
    return this.resolutionsByRule.get(ruleId) ?? [];
  }

  /** Fingerprints the agent explicitly confirmed still-open for this rule. */
  openFor(ruleId: string): string[] {
    return [...(this.openByRule.get(ruleId) ?? [])];
  }

  /** Every (ruleId, fingerprint) the agents confirmed still-open this run. */
  allOpen(): { ruleId: string; fingerprint: string }[] {
    const out: { ruleId: string; fingerprint: string }[] = [];
    for (const [ruleId, set] of this.openByRule) {
      for (const fingerprint of set) out.push({ ruleId, fingerprint });
    }
    return out;
  }

  /** Record a review summary. Only the first call per ruleId is kept — subsequent
   *  calls return false. The runner uses `summaryFor()` to detect rules that
   *  never signed off (likely incomplete reviews). */
  addSummary(summary: ReviewSummary): boolean {
    if (this.summaryByRule.has(summary.ruleId)) return false;
    this.summaryByRule.set(summary.ruleId, summary);
    for (const l of this.summaryListeners) {
      try { l(summary); } catch { /* listener errors must not affect aggregation */ }
    }
    return true;
  }

  summaryFor(ruleId: string): ReviewSummary | undefined {
    return this.summaryByRule.get(ruleId);
  }

  /** 1 if the rule emitted a summary, 0 otherwise. (Duplicate summaries are
   *  rejected, so this never exceeds 1.) */
  summaryCountFor(ruleId: string): number {
    return this.summaryByRule.has(ruleId) ? 1 : 0;
  }

  all(): Finding[] {
    const out: Finding[] = [];
    for (const list of this.byRule.values()) out.push(...list);
    return out;
  }

  allResolutions(): Resolution[] {
    const out: Resolution[] = [];
    for (const list of this.resolutionsByRule.values()) out.push(...list);
    return out;
  }

  allSummaries(): ReviewSummary[] {
    return Array.from(this.summaryByRule.values());
  }

  /** Record an incremental compliance check. Dedups exact duplicates within a
   *  rule so a chatty agent doesn't fill the report with the same line twice. */
  addCheck(check: Check): boolean {
    const key = `${check.ruleId}\0${check.path}\0${check.line ?? ""}\0${check.lineEnd ?? ""}\0${check.message}`;
    if (this.checkDedupKeys.has(key)) return false;
    this.checkDedupKeys.add(key);

    const list = this.checksByRule.get(check.ruleId);
    if (list) list.push(check);
    else this.checksByRule.set(check.ruleId, [check]);
    for (const l of this.checkListeners) {
      try { l(check); } catch { /* listener errors must not affect aggregation */ }
    }
    return true;
  }

  checksFor(ruleId: string): Check[] {
    return this.checksByRule.get(ruleId) ?? [];
  }

  checkCountFor(ruleId: string): number {
    return this.checksByRule.get(ruleId)?.length ?? 0;
  }

  allChecks(): Check[] {
    const out: Check[] = [];
    for (const list of this.checksByRule.values()) out.push(...list);
    return out;
  }

  maxSeverity(): Severity | undefined {
    let max = -1;
    for (const f of this.all()) {
      const idx = SEVERITIES.indexOf(f.severity);
      if (idx > max) max = idx;
    }
    return max < 0 ? undefined : SEVERITIES[max];
  }
}
