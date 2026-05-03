export interface InitUserPromptInput {
  repoRoot: string;
  force: boolean;
}

export function buildInitUserPrompt(input: InitUserPromptInput): string {
  const overwrite = input.force
    ? "You may overwrite existing `.revu.md` files if you decide a better one belongs in the same place."
    : "Do NOT overwrite existing `.revu.md` files. If one already exists at a path you would otherwise choose, pick a different name or skip that rule.";

  return `Inspect the repository at \`${input.repoRoot}\` and create a curated set of revu rule files.

Steps:
1. Identify the stack and conventions (read whatever README / contributor docs / config / setup files exist).
2. Map the structure and rough size with git/glob.
3. Search for implicit contracts first — these are the highest-value rules.
4. Choose seed categories that are meaningfully verifiable in this repo's stack.
5. Decide global vs local placement for each rule.
6. Write each rule file with the \`Write\` tool, following the format spec exactly.
7. End your turn with a single short summary listing each file you created and whether it is global or local.

${overwrite}

Begin.`;
}
