import { claudeCodeProvider, claudeCodeScaffoldProvider } from "./claude-code.js";
import type { ReviewAgentFactory, ScaffoldAgentFactory } from "./types.js";

interface ProviderEntry {
  review?: ReviewAgentFactory;
  scaffold?: ScaffoldAgentFactory;
}

const REGISTRY: Map<string, ProviderEntry> = new Map([
  [
    "claude-code",
    {
      review: claudeCodeProvider as ReviewAgentFactory,
      scaffold: claudeCodeScaffoldProvider as ScaffoldAgentFactory,
    },
  ],
]);

function entry(name: string): ProviderEntry {
  let e = REGISTRY.get(name);
  if (!e) {
    e = {};
    REGISTRY.set(name, e);
  }
  return e;
}

export function registerProvider(name: string, factory: ReviewAgentFactory): void {
  entry(name).review = factory;
}

export function unregisterProvider(name: string): void {
  const e = REGISTRY.get(name);
  if (!e) return;
  delete e.review;
  if (!e.review && !e.scaffold) REGISTRY.delete(name);
}

export function registerScaffoldProvider(name: string, factory: ScaffoldAgentFactory): void {
  entry(name).scaffold = factory;
}

export function unregisterScaffoldProvider(name: string): void {
  const e = REGISTRY.get(name);
  if (!e) return;
  delete e.scaffold;
  if (!e.review && !e.scaffold) REGISTRY.delete(name);
}

export function getProviderFactory(name: string): ReviewAgentFactory {
  const factory = REGISTRY.get(name)?.review;
  if (!factory) {
    const known = [...REGISTRY.entries()].filter(([, e]) => e.review).map(([k]) => k).join(", ");
    throw new Error(`Unknown review provider "${name}". Known: ${known}`);
  }
  return factory;
}

export function getScaffoldFactory(name: string): ScaffoldAgentFactory {
  const factory = REGISTRY.get(name)?.scaffold;
  if (!factory) {
    const known = [...REGISTRY.entries()].filter(([, e]) => e.scaffold).map(([k]) => k).join(", ");
    throw new Error(`Unknown scaffold provider "${name}". Known: ${known}`);
  }
  return factory;
}

export function listProviders(): string[] {
  return [...REGISTRY.keys()];
}
