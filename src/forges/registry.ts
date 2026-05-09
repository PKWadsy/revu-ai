import { githubForgeFactory } from "./github/index.js";
import { gitlabForgeFactory } from "./gitlab/index.js";
import type { ForgeAdapter, ForgeAdapterFactory } from "./types.js";

const REGISTRY: Map<string, ForgeAdapterFactory> = new Map([
  ["github", githubForgeFactory],
  ["gitlab", gitlabForgeFactory],
]);

export function registerForge(name: string, factory: ForgeAdapterFactory): void {
  REGISTRY.set(name, factory);
}

export function unregisterForge(name: string): void {
  REGISTRY.delete(name);
}

export function getForge(name: string): ForgeAdapter {
  const factory = REGISTRY.get(name);
  if (!factory) {
    const known = [...REGISTRY.keys()].join(", ");
    throw new Error(`Unknown forge "${name}". Known: ${known}`);
  }
  return factory();
}

export function listForges(): string[] {
  return [...REGISTRY.keys()];
}
