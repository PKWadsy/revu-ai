export { run, listRules, RevuExit } from "./runner.js";
export type { RunnerResult, RunHooks } from "./runner.js";
export { registerProvider, unregisterProvider, getProviderFactory, listProviders } from "./providers/registry.js";
export type { ReviewAgent, ReviewAgentFactory, ReviewInput, ReviewResult } from "./providers/types.js";
export { startSidecar } from "./mcp/server.js";
export type { SidecarHandle } from "./mcp/server.js";
export { FindingsAggregator } from "./mcp/aggregator.js";
export { loadConfig, DEFAULT_CONFIG } from "./config.js";
export type {
  Finding,
  Severity,
  RuleFile,
  ReviewTarget,
  ResolvedTarget,
  RuleResult,
  RunReport,
  RevuConfig,
} from "./types.js";
