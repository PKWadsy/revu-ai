import { randomUUID } from "node:crypto";
import { findRepoRoot, resolveTarget, isReviewEmpty } from "./refs.js";
import { discoverRules } from "./discovery.js";
import { startSidecar } from "./mcp/server.js";
import { getHarnessFactory } from "./providers/registry.js";
import { createLimiter } from "./concurrency.js";
import { SEVERITY_ORDER } from "./types.js";
import micromatch from "micromatch";
import type {
  Finding,
  RevuConfig,
  RunReport,
  RuleResult,
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
  const factory = getHarnessFactory(config.harness);
  const provider = factory({
    ...(config.model ? { model: config.model } : {}),
    ...(config.provider ? { provider: config.provider } : {}),
  });

  const concurrency = config.concurrency ?? Math.min(8, rules.length);
  const limit = createLimiter(concurrency);

  const ruleResults: RuleResult[] = [];

  try {
    await Promise.all(
      rules.map((rule) =>
        limit(async () => {
          hooks.onRuleStart?.(rule.ruleId, rule.relPath);
          const priorForRule = priorByRule.get(rule.ruleId);
          const ruleStart = Date.now();

          // Skip this rule if it declares file patterns but none of the changed
          // files match. This avoids spawning an agent that would have nothing to do.
          if (rule.filePatterns && rule.filePatterns.length > 0) {
            const matchingFiles = micromatch(resolved.changedFiles, rule.filePatterns);
            if (matchingFiles.length === 0) {
              const skipped: RuleResult = {
                id: rule.ruleId,
                path: rule.relPath,
                ok: true,
                durationMs: 0,
                findingCount: 0,
                skipped: true,
              };
              ruleResults.push(skipped);
              hooks.onRuleEnd?.(skipped);
              return;
            }
          }

          // Per-rule isolation: a provider that throws (bug, runtime
          // error, anything we didn't anticipate) must not abort the
          // whole run. Catch here, convert to an errored RuleResult, and
          // let the other rules finish. The provider's own contract is
          // already to return ReviewResult with `ok:false` on expected
          // failures — this is the safety net for unexpected ones.
          let ruleResult: RuleResult;
          try {
            const result = await provider.run({
              ruleId: rule.ruleId,
              rulesFilePath: rule.absPath,
              rulesContent: rule.content,
              reviewTarget: resolved.target,
              repoRoot,
              mcp: { url: sidecar.url, authToken: sidecar.authToken },
              timeoutMs: config.timeoutMs,
              ...(hooks.onActivity
                ? { onActivity: (a) => hooks.onActivity?.(rule.ruleId, a) }
                : {}),
              ...(priorForRule && priorForRule.length > 0 ? { priorFindings: priorForRule } : {}),
              ...(priorHeadSha ? { priorHeadSha } : {}),
              ...(rule.filePatterns ? { filePatterns: rule.filePatterns } : {}),
            });
            ruleResult = {
              id: result.ruleId,
              path: rule.relPath,
              ok: result.ok,
              durationMs: result.durationMs,
              findingCount: sidecar.aggregator.countFor(result.ruleId),
              ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
              ...(result.timedOut ? { timedOut: true } : {}),
            };
          } catch (e) {
            const message = (e as Error)?.stack ?? (e as Error)?.message ?? String(e);
            ruleResult = {
              id: rule.ruleId,
              path: rule.relPath,
              ok: false,
              durationMs: Date.now() - ruleStart,
              findingCount: sidecar.aggregator.countFor(rule.ruleId),
              errorMessage: `unexpected error: ${message.split("\n")[0]}`,
            };
          }
          ruleResults.push(ruleResult);
          hooks.onRuleEnd?.(ruleResult);
        }),
      ),
    );
  } finally {
    unsubscribeFindings();
    await sidecar.shutdown();
  }

  const findings: Finding[] = sidecar.aggregator.all();
  const resolutions = sidecar.aggregator.allResolutions();

  const report: RunReport = {
    schemaVersion: 2,
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    reviewTarget: { ...resolved, mode: resolved.target.mode },
    rules: ruleResults.sort((a, b) => a.id.localeCompare(b.id)),
    findings: findings.sort(findingSort),
    resolutions,
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

export async function listRules(cwd: string, pattern: string): Promise<{ relPath: string; ruleId: string }[]> {
  const repoRoot = findRepoRoot(cwd);
  const rules = await discoverRules(repoRoot, pattern);
  return rules.map((r) => ({ relPath: r.relPath, ruleId: r.ruleId }));
}
