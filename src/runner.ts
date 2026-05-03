import { randomUUID } from "node:crypto";
import { findRepoRoot, resolveTarget, isReviewEmpty } from "./refs.js";
import { discoverRules } from "./discovery.js";
import { startSidecar } from "./mcp/server.js";
import { getProviderFactory } from "./providers/registry.js";
import { createLimiter } from "./concurrency.js";
import { SEVERITY_ORDER } from "./types.js";
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

export async function run(cwd: string, config: RevuConfig, hooks: RunHooks = {}): Promise<RunnerResult> {
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

  const sidecar = await startSidecar({ repoRoot });
  const unsubscribeFindings = hooks.onFinding
    ? sidecar.aggregator.onAdd(hooks.onFinding)
    : () => {};
  const factory = getProviderFactory(config.provider);
  const provider = factory({ ...(config.model ? { model: config.model } : {}) });

  const concurrency = config.concurrency ?? Math.min(8, rules.length);
  const limit = createLimiter(concurrency);

  const ruleResults: RuleResult[] = [];

  try {
    await Promise.all(
      rules.map((rule) =>
        limit(async () => {
          hooks.onRuleStart?.(rule.ruleId, rule.relPath);
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
          });
          const ruleResult: RuleResult = {
            id: result.ruleId,
            path: rule.relPath,
            ok: result.ok,
            durationMs: result.durationMs,
            findingCount: sidecar.aggregator.countFor(result.ruleId),
            ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
            ...(result.timedOut ? { timedOut: true } : {}),
          };
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

  const report: RunReport = {
    schemaVersion: 1,
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    reviewTarget: { ...resolved, mode: resolved.target.mode },
    rules: ruleResults.sort((a, b) => a.id.localeCompare(b.id)),
    findings: findings.sort(findingSort),
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
