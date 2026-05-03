import { execFileSync } from "node:child_process";
import type { ResolvedTarget, ReviewTarget } from "./types.js";

export function findRepoRoot(cwd: string): string {
  return git(["rev-parse", "--show-toplevel"], cwd).trim();
}

export interface ResolveOptions {
  base?: string;
  workingTree: boolean;
  staged: boolean;
}

export function resolveTarget(repoRoot: string, opts: ResolveOptions): ResolvedTarget {
  if (opts.workingTree) {
    return {
      target: { mode: "working-tree" },
      changedFiles: changedFilesFor({ mode: "working-tree" }, repoRoot),
    };
  }
  if (opts.staged) {
    return {
      target: { mode: "staged" },
      changedFiles: changedFilesFor({ mode: "staged" }, repoRoot),
    };
  }

  const base = opts.base ?? autoDetectBase(repoRoot);
  const target: ReviewTarget = { mode: "ref-range", base, head: "HEAD" };
  return {
    target,
    baseSha: tryGit(["rev-parse", base], repoRoot),
    headSha: tryGit(["rev-parse", "HEAD"], repoRoot),
    changedFiles: changedFilesFor(target, repoRoot),
  };
}

function autoDetectBase(repoRoot: string): string {
  for (const candidate of ["origin/main", "origin/master"]) {
    if (tryGit(["rev-parse", "--verify", candidate], repoRoot)) {
      return candidate;
    }
  }
  const symref = tryGit(["symbolic-ref", "refs/remotes/origin/HEAD"], repoRoot);
  if (symref) {
    return symref.replace(/^refs\/remotes\//, "");
  }
  return "HEAD~1";
}

export function isReviewEmpty(target: ReviewTarget, repoRoot: string): boolean {
  try {
    if (target.mode === "ref-range") {
      git(["diff", "--quiet", `${target.base}...${target.head}`], repoRoot);
    } else if (target.mode === "working-tree") {
      git(["diff", "--quiet", "HEAD"], repoRoot);
    } else {
      git(["diff", "--quiet", "--staged"], repoRoot);
    }
    return true;
  } catch {
    return false;
  }
}

function changedFilesFor(target: ReviewTarget, repoRoot: string): string[] {
  let args: string[];
  if (target.mode === "ref-range") {
    args = ["diff", "--name-only", `${target.base}...${target.head}`];
  } else if (target.mode === "working-tree") {
    args = ["diff", "--name-only", "HEAD"];
  } else {
    args = ["diff", "--name-only", "--staged"];
  }
  const out = tryGit(args, repoRoot) ?? "";
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function tryGit(args: string[], cwd: string): string | undefined {
  try {
    return git(args, cwd).trim();
  } catch {
    return undefined;
  }
}
