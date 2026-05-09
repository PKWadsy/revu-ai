import { claudeCodeProvider, claudeCodeScaffoldProvider } from "./claude-code.js";
import { opencodeProvider, opencodeScaffoldProvider } from "./opencode.js";
import type { ReviewAgentFactory, ScaffoldAgentFactory } from "./types.js";

interface HarnessEntry {
  review?: ReviewAgentFactory;
  scaffold?: ScaffoldAgentFactory;
}

const HARNESSES: Map<string, HarnessEntry> = new Map([
  [
    "claude-code",
    {
      review: claudeCodeProvider as ReviewAgentFactory,
      scaffold: claudeCodeScaffoldProvider as ScaffoldAgentFactory,
    },
  ],
  [
    "opencode",
    {
      review: opencodeProvider as ReviewAgentFactory,
      scaffold: opencodeScaffoldProvider as ScaffoldAgentFactory,
    },
  ],
]);

function entry(name: string): HarnessEntry {
  let e = HARNESSES.get(name);
  if (!e) {
    e = {};
    HARNESSES.set(name, e);
  }
  return e;
}

export function registerHarness(name: string, factory: ReviewAgentFactory): void {
  entry(name).review = factory;
}

export function unregisterHarness(name: string): void {
  const e = HARNESSES.get(name);
  if (!e) return;
  delete e.review;
  if (!e.review && !e.scaffold) HARNESSES.delete(name);
}

export function registerScaffoldHarness(name: string, factory: ScaffoldAgentFactory): void {
  entry(name).scaffold = factory;
}

export function unregisterScaffoldHarness(name: string): void {
  const e = HARNESSES.get(name);
  if (!e) return;
  delete e.scaffold;
  if (!e.review && !e.scaffold) HARNESSES.delete(name);
}

export function getHarnessFactory(name: string): ReviewAgentFactory {
  const factory = HARNESSES.get(name)?.review;
  if (!factory) {
    const known = [...HARNESSES.entries()].filter(([, e]) => e.review).map(([k]) => k).join(", ");
    throw new Error(`Unknown review harness "${name}". Known: ${known}`);
  }
  return factory;
}

export function getScaffoldHarness(name: string): ScaffoldAgentFactory {
  const factory = HARNESSES.get(name)?.scaffold;
  if (!factory) {
    const known = [...HARNESSES.entries()].filter(([, e]) => e.scaffold).map(([k]) => k).join(", ");
    throw new Error(`Unknown scaffold harness "${name}". Known: ${known}`);
  }
  return factory;
}

export function listHarnesses(): string[] {
  return [...HARNESSES.keys()];
}
