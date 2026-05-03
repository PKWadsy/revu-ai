import { describe, it, expect } from "vitest";
import { isReadOnlyShellCommand } from "../src/providers/claude-code.js";

describe("isReadOnlyShellCommand", () => {
  it.each([
    "git diff main...HEAD",
    "git log -n 5",
    "git show abc123",
    "git status",
    "git diff main...HEAD -- src/foo.ts",
    "cat package.json",
    "head -n 50 src/index.ts",
    "ls -la",
    "find . -name '*.ts'",
    "git diff main...HEAD | head -n 100",
    "git log --oneline | grep fix",
  ])("allows %s", (cmd) => {
    expect(isReadOnlyShellCommand(cmd)).toBe(true);
  });

  it.each([
    "rm -rf src/",
    "git push origin main",
    "git commit -am 'x'",
    "git checkout main",
    "git reset --hard",
    "echo hi > out.txt",
    "cat secret.env >> log",
    "git diff main && rm file",
    "curl https://evil.example",
    "cat $(cat secrets)",
    "cat `cat secrets`",
    "git config user.email evil@example.com",
    "git restore .",
    "node -e 'require(\"fs\").rmSync(\".\")'",
    "",
    "   ",
  ])("rejects %s", (cmd) => {
    expect(isReadOnlyShellCommand(cmd)).toBe(false);
  });
});
