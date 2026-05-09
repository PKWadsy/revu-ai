import { SEVERITIES, type Finding, type Resolution, type Severity } from "../types.js";

export class FindingsAggregator {
  private byRule = new Map<string, Finding[]>();
  private dedupKeys = new Set<string>();
  private listeners = new Set<(f: Finding) => void>();
  private resolutionsByRule = new Map<string, Resolution[]>();
  private resolutionDedupKeys = new Set<string>();
  private resolutionListeners = new Set<(r: Resolution) => void>();

  onAdd(listener: (f: Finding) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onResolution(listener: (r: Resolution) => void): () => void {
    this.resolutionListeners.add(listener);
    return () => this.resolutionListeners.delete(listener);
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

  countFor(ruleId: string): number {
    return this.byRule.get(ruleId)?.length ?? 0;
  }

  resolutionsFor(ruleId: string): Resolution[] {
    return this.resolutionsByRule.get(ruleId) ?? [];
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

  maxSeverity(): Severity | undefined {
    let max = -1;
    for (const f of this.all()) {
      const idx = SEVERITIES.indexOf(f.severity);
      if (idx > max) max = idx;
    }
    return max < 0 ? undefined : SEVERITIES[max];
  }
}
