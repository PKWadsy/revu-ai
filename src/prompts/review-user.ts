import type { ReviewTarget } from "../types.js";

export function buildUserPrompt(target: ReviewTarget): string {
  if (target.mode === "ref-range") {
    return `Review the changes between \`${target.base}\` and \`${target.head}\`. Start with \`git diff ${target.base}...${target.head}\` to see what changed, then verify your findings as needed before reporting them.`;
  }
  if (target.mode === "working-tree") {
    return `Review the uncommitted changes in the working tree. Start with \`git status\` and \`git diff HEAD\`.`;
  }
  return `Review the staged changes. Start with \`git diff --staged\`.`;
}
