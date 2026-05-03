import { claudeCodeProvider } from "./claude-code.js";
import type { ReviewAgentFactory } from "./types.js";

const REGISTRY: Map<string, ReviewAgentFactory> = new Map([
  ["claude-code", claudeCodeProvider as ReviewAgentFactory],
]);

export function registerProvider(name: string, factory: ReviewAgentFactory): void {
  REGISTRY.set(name, factory);
}

export function unregisterProvider(name: string): void {
  REGISTRY.delete(name);
}

export function getProviderFactory(name: string): ReviewAgentFactory {
  const factory = REGISTRY.get(name);
  if (!factory) {
    const known = [...REGISTRY.keys()].join(", ");
    throw new Error(`Unknown provider "${name}". Known providers: ${known}`);
  }
  return factory;
}

export function listProviders(): string[] {
  return [...REGISTRY.keys()];
}
