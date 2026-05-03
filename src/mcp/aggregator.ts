import type { Finding, Severity } from "../types.js";

export class FindingsAggregator {
  private byRule = new Map<string, Finding[]>();
  private dedupKeys = new Set<string>();
  private listeners = new Set<(f: Finding) => void>();

  onAdd(listener: (f: Finding) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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

  countFor(ruleId: string): number {
    return this.byRule.get(ruleId)?.length ?? 0;
  }

  all(): Finding[] {
    const out: Finding[] = [];
    for (const list of this.byRule.values()) out.push(...list);
    return out;
  }

  maxSeverity(): Severity | undefined {
    const order: Severity[] = ["aesthetic", "low", "medium", "high", "critical"];
    let max = -1;
    for (const f of this.all()) {
      const idx = order.indexOf(f.severity);
      if (idx > max) max = idx;
    }
    return max < 0 ? undefined : order[max];
  }
}
