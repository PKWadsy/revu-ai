import { randomUUID } from "node:crypto";
import { findRepoRoot, resolveTarget, isReviewEmpty } from "./refs.js";
import { discoverRules } from "./discovery.js";
import { startSidecar } from "./mcp/server.js";
import { getHarnessFactory } from "./providers/registry.js";
import { createLimiter } from "./concurrency.js";
import { SEVERITY_ORDER } from "./types.js";
import micromatch from "micromatch";
import type {
  Check,
  Finding,
  RevuConfig,
  RunReport,
  RuleFile,
  RuleResult,
  ReviewSummary,
  Severity,
} from "./types.js";
import type { ReviewActivity } from "./providers/types.js";

export interface RunnerResult {
  report: RunReport;
  exitCode: number;
}

export class RevuExit extends Error {
  constructor(message: string, public readonly exitCode: number) {
    super(message);
    this.name = "RevuExit";
  }
}

export interface RunHooks {
  onRuleStart?: (ruleId: string, relPath: string) => void;
  onRuleEnd?: (result: RuleResult) => void;
  /** Fires whenever a rule agent uses a tool or emits text. */
  onActivity?: (ruleId: string, activity: ReviewActivity) => void;
  /** Fires for each finding the moment it's reported through the MCP sidecar. */
  onFinding?: (finding: Finding) => void;
  /** Fires when a rule's review summary lands on the MCP sidecar. */
  onSummary?: (summary: ReviewSummary) => void;
  /** Fires for each `report_check` call — incremental compliance evidence. */
  onCheck?: (check: Check) => void;
  /** Fires when a stage begins, with its display label and how many rules it contains. */
  onStageStart?: (label: string, ruleCount: number) => void;
  /** Fires when a stage trips the gate, stopping the run. */
  onGate?: (label: string, gatingFindingCount: number, threshold: Severity) => void;
}

export interface RunInputs {
  /** Optional prior-run report. When present, each rule's open prior findings are
   *  threaded into that rule's reviewer agent for cross-run reasoning. */
  priorReport?: RunReport;
}

export async function run(cwd: string, config: RevuConfig, hooks: RunHooks = {}, inputs: RunInputs = {}): Promise<RunnerResult> {
  const startedAt = new Date().toISOString();
  const runId = randomUUID();
  const repoRoot = findRepoRoot(cwd);

  const rules = await discoverRules(repoRoot, config.pattern);
  if (rules.length === 0) {
    throw new RevuExit(`No rule files found matching ${config.pattern}`, 0);
  }

  const resolved = resolveTarget(repoRoot, {
    base: config.base,
    workingTree: config.workingTree,
    staged: config.staged,
  });

  if (!config.force && isReviewEmpty(resolved.target, repoRoot)) {
    throw new RevuExit("No changes to review.", 0);
  }

  // Group prior findings by ruleId so each agent only sees its own.
  const priorByRule = new Map<string, Finding[]>();
  if (inputs.priorReport) {
    const resolvedFps = new Set(
      inputs.priorReport.resolutions?.map((r) => `${r.ruleId}\0${r.fingerprint}`) ?? [],
    );
    for (const f of inputs.priorReport.findings) {
      // Skip findings that the prior report already marked resolved.
      if (resolvedFps.has(`${f.ruleId}\0${f.fingerprint}`)) continue;
      const list = priorByRule.get(f.ruleId);
      if (list) list.push(f);
      else priorByRule.set(f.ruleId, [f]);
    }
  }
  const priorHeadSha = inputs.priorReport?.reviewTarget.headSha;

  const sidecar = await startSidecar({ repoRoot });
  const unsubscribeFindings = hooks.onFinding
    ? sidecar.aggregator.onAdd(hooks.onFinding)
    : () => {};
  const unsubscribeSummaries = hooks.onSummary
    ? sidecar.aggregator.onSummary(hooks.onSummary)
    : () => {};
  const unsubscribeChecks = hooks.onCheck
    ? sidecar.aggregator.onCheck(hooks.onCheck)
    : () => {};
  const factory = getHarnessFactory(config.harness);
  const provider = factory({
    ...(config.model ? { model: config.model } : {}),
    ...(config.provider ? { provider: config.provider } : {}),
  });

  const concurrency = config.concurrency ?? Math.min(8, rules.length);
  const limit = createLimiter(concurrency);

  const ruleResults: RuleResult[] = [];

  // A prior finding is "accounted for" this run when its rule explicitly confirmed it
  // still-open (mark_finding_open, or a report_finding carrying its fingerprint via `priorFp`
  // or re-reported at the same fingerprint) or resolved it (mark_finding_resolved). Anything
  // left untouched means the agent didn't demonstrably re-examine it — the review is incomplete
  // and must fail loudly rather than silently dropping the finding or carrying it forever.
  const unaccountedPriors = (ruleId: string, priors: Finding[]): Finding[] => {
    if (priors.length === 0) return [];
    const accounted = new Set<string>();
    for (const r of sidecar.aggregator.resolutionsFor(ruleId)) accounted.add(r.fingerprint);
    for (const fp of sidecar.aggregator.openFor(ruleId)) accounted.add(fp);
    for (const f of sidecar.aggregator.findingsFor(ruleId)) {
      if (f.priorFp) accounted.add(f.priorFp);
      accounted.add(f.fingerprint);
    }
    return priors.filter((p) => !accounted.has(p.fingerprint));
  };

  // Runs a single rule end-to-end (pre-flight file filtering + provider) and returns its
  // result. Pure w.r.t. ruleResults — the caller pushes and fires onRuleEnd.
  const executeRule = async (rule: (typeof rules)[number]): Promise<RuleResult> => {
    const priorForRule = priorByRule.get(rule.ruleId);
    const ruleStart = Date.now();

    if (rule.filePatterns !== undefined) {
      if (rule.filePatterns.length === 0) {
        return {
          id: rule.ruleId, path: rule.relPath, ok: false,
          durationMs: Date.now() - ruleStart, findingCount: 0, summaryCount: 0, checkCount: 0,
          errorMessage: "files: pattern list is empty — add at least one glob pattern or remove the key",
        };
      }
      let matchingFiles: string[];
      try {
        matchingFiles = micromatch(resolved.changedFiles, rule.filePatterns);
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        return {
          id: rule.ruleId, path: rule.relPath, ok: false,
          durationMs: Date.now() - ruleStart, findingCount: 0, summaryCount: 0, checkCount: 0,
          errorMessage: `invalid files: pattern — ${msg}`,
        };
      }
      if (matchingFiles.length === 0) {
        return {
          id: rule.ruleId, path: rule.relPath, ok: true,
          durationMs: 0, findingCount: 0, summaryCount: 0, checkCount: 0, skipped: true,
        };
      }
    }

    try {
      const result = await provider.run({
        ruleId: rule.ruleId,
        rulesFilePath: rule.absPath,
        rulesContent: rule.content,
        reviewTarget: resolved.target,
        repoRoot,
        mcp: { url: sidecar.url, authToken: sidecar.authToken },
        timeoutMs: config.timeoutMs,
        ...(hooks.onActivity ? { onActivity: (a) => hooks.onActivity?.(rule.ruleId, a) } : {}),
        ...(priorForRule && priorForRule.length > 0 ? { priorFindings: priorForRule } : {}),
        ...(priorHeadSha ? { priorHeadSha } : {}),
        ...(rule.filePatterns ? { filePatterns: rule.filePatterns } : {}),
      });
      // Enforce prior-finding accounting: a clean run that ignored any prior finding
      // is an incomplete review and fails, so a coding agent can't merge past findings
      // the reviewer never re-examined.
      let ok = result.ok;
      let errorMessage = result.errorMessage;
      if (result.ok && !result.timedOut && priorForRule && priorForRule.length > 0) {
        const missing = unaccountedPriors(result.ruleId, priorForRule);
        if (missing.length > 0) {
          ok = false;
          errorMessage =
            `incomplete review: ${missing.length} prior finding(s) left unaccounted — every prior finding must be ` +
            `confirmed still-open (mark_finding_open / report_finding) or resolved (mark_finding_resolved). ` +
            `Unaccounted: ${missing.map((f) => f.fingerprint).join(", ")}`;
        }
      }
      return {
        id: result.ruleId, path: rule.relPath, ok, durationMs: result.durationMs,
        findingCount: sidecar.aggregator.countFor(result.ruleId),
        summaryCount: sidecar.aggregator.summaryCountFor(result.ruleId),
        checkCount: sidecar.aggregator.checkCountFor(result.ruleId),
        ...(errorMessage ? { errorMessage } : {}),
        ...(result.timedOut ? { timedOut: true } : {}),
        ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
      };
    } catch (e) {
      const message = (e as Error)?.stack ?? (e as Error)?.message ?? String(e);
      return {
        id: rule.ruleId, path: rule.relPath, ok: false,
        durationMs: Date.now() - ruleStart,
        findingCount: sidecar.aggregator.countFor(rule.ruleId),
        summaryCount: sidecar.aggregator.summaryCountFor(rule.ruleId),
        checkCount: sidecar.aggregator.checkCountFor(rule.ruleId),
        errorMessage: `unexpected error: ${message.split("\n")[0]}`,
      };
    }
  };

  const gateThreshold = SEVERITY_ORDER[config.gateOn];

  try {
    const groups = groupRulesByStage(rules);
    let gated = false;

    for (const group of groups) {
      if (gated) {
        for (const rule of group.rules) {
          const result: RuleResult = {
            id: rule.ruleId, path: rule.relPath, ok: true,
            durationMs: 0, findingCount: 0, summaryCount: 0, checkCount: 0, gated: true,
          };
          ruleResults.push(result);
          hooks.onRuleEnd?.(result);
        }
        continue;
      }

      hooks.onStageStart?.(group.label, group.rules.length);
      await Promise.all(
        group.rules.map((rule) =>
          limit(async () => {
            hooks.onRuleStart?.(rule.ruleId, rule.relPath);
            const result = await executeRule(rule);
            ruleResults.push(result);
            hooks.onRuleEnd?.(result);
          }),
        ),
      );

      const maxSev = maxFindingSeverity(sidecar.aggregator.all());
      if (maxSev !== undefined && maxSev >= gateThreshold) {
        gated = true;
        const gatingCount = sidecar.aggregator.all().filter(
          (f) => SEVERITY_ORDER[f.severity] >= gateThreshold,
        ).length;
        hooks.onGate?.(group.label, gatingCount, config.gateOn);
      }
    }
  } finally {
    unsubscribeFindings();
    unsubscribeSummaries();
    unsubscribeChecks();
    await sidecar.shutdown();
  }

  const findings: Finding[] = sidecar.aggregator.all();

  // Re-inject prior findings the agents confirmed still-open via `mark_finding_open`
  // (those that weren't separately re-reported). They aren't fresh findings, but they
  // are still open, so they belong in the report — the exit code and the carried-forward
  // cache must reflect that the issue persists.
  const currentHeadSha = resolved.headSha ?? priorHeadSha ?? "";
  const presentFps = new Set(findings.map((f) => f.fingerprint));
  for (const { ruleId, fingerprint } of sidecar.aggregator.allOpen()) {
    if (presentFps.has(fingerprint)) continue;
    const prior = priorByRule.get(ruleId)?.find((f) => f.fingerprint === fingerprint);
    if (!prior) continue;
    findings.push({ ...prior, lastSeenSha: currentHeadSha });
    presentFps.add(fingerprint);
  }

  const resolutions = sidecar.aggregator.allResolutions();
  const summaries = sidecar.aggregator
    .allSummaries()
    .sort((a, b) => a.ruleId.localeCompare(b.ruleId));
  const checks = sidecar.aggregator.allChecks().sort(checkSort);

  const report: RunReport = {
    schemaVersion: 3,
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    reviewTarget: { ...resolved, mode: resolved.target.mode },
    rules: ruleResults.sort((a, b) => a.id.localeCompare(b.id)),
    findings: findings.sort(findingSort),
    resolutions,
    summaries,
    checks,
  };

  const exitCode = computeExitCode(findings, ruleResults, config.failOn);
  return { report, exitCode };
}

function computeExitCode(findings: Finding[], rules: RuleResult[], failOn: Severity): number {
  if (rules.some((r) => !r.ok)) return 2;
  const threshold = SEVERITY_ORDER[failOn];
  const triggered = findings.some((f) => SEVERITY_ORDER[f.severity] >= threshold);
  return triggered ? 1 : 0;
}

function findingSort(a: Finding, b: Finding): number {
  const sevDiff = SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity];
  if (sevDiff !== 0) return sevDiff;
  if (a.path !== b.path) return a.path.localeCompare(b.path);
  return (a.line ?? 0) - (b.line ?? 0);
}

function checkSort(a: Check, b: Check): number {
  if (a.ruleId !== b.ruleId) return a.ruleId.localeCompare(b.ruleId);
  if (a.path !== b.path) return a.path.localeCompare(b.path);
  return (a.line ?? 0) - (b.line ?? 0);
}

interface StageGroup {
  label: string;
  rules: RuleFile[];
}

/**
 * Group rules into ordered execution stages.
 *  - Numbered stages run in ascending order, rules within a stage in parallel.
 *  - Unstaged rules (no `stage:`) form a single final group that runs after all numbered stages.
 *  - If NO rule declares a stage, the result is one group containing everything — byte-for-byte
 *    today's single-pass behavior.
 */
function groupRulesByStage(rules: RuleFile[]): StageGroup[] {
  const numbered = new Map<number, RuleFile[]>();
  const unstaged: RuleFile[] = [];
  for (const rule of rules) {
    if (rule.stage === undefined) {
      unstaged.push(rule);
    } else {
      const list = numbered.get(rule.stage);
      if (list) list.push(rule);
      else numbered.set(rule.stage, [rule]);
    }
  }
  const groups: StageGroup[] = [...numbered.keys()]
    .sort((a, b) => a - b)
    .map((n) => ({ label: `stage ${n}`, rules: numbered.get(n)! }));
  if (unstaged.length > 0) {
    groups.push({ label: groups.length > 0 ? "unstaged" : "all", rules: unstaged });
  }
  return groups;
}

function maxFindingSeverity(findings: Finding[]): number | undefined {
  let max: number | undefined;
  for (const f of findings) {
    const s = SEVERITY_ORDER[f.severity];
    if (max === undefined || s > max) max = s;
  }
  return max;
}

export async function listRules(cwd: string, pattern: string): Promise<{ relPath: string; ruleId: string }[]> {
  const repoRoot = findRepoRoot(cwd);
  const rules = await discoverRules(repoRoot, pattern);
  return rules.map((r) => ({ relPath: r.relPath, ruleId: r.ruleId }));
}
