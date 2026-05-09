import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkReadInput } from "../src/providers/claude-code.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "revu-read-gate-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("checkReadInput — pre-flight Read gate", () => {
  it("allows small files", () => {
    const p = join(dir, "small.ts");
    writeFileSync(p, "export const x = 1;\n");
    expect(checkReadInput({ file_path: p })).toEqual({ allow: true });
  });

  it("denies oversized files when no `limit` is set", () => {
    const p = join(dir, "huge.ts");
    // 100 KB > 80 KB soft cap.
    writeFileSync(p, "x".repeat(100_000));
    const d = checkReadInput({ file_path: p });
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.reason).toMatch(/too large/);
      expect(d.reason).toMatch(/offset/);
      expect(d.reason).toMatch(/limit/);
      expect(d.reason).toMatch(/Grep/);
    }
  });

  it("allows oversized files when `limit` is set (agent is chunking)", () => {
    const p = join(dir, "huge.ts");
    writeFileSync(p, "x".repeat(100_000));
    expect(checkReadInput({ file_path: p, limit: 500 })).toEqual({ allow: true });
  });

  it("ignores `limit: 0` (treats as no limit)", () => {
    const p = join(dir, "huge.ts");
    writeFileSync(p, "x".repeat(100_000));
    const d = checkReadInput({ file_path: p, limit: 0 });
    expect(d.allow).toBe(false);
  });

  it("denies directories with Glob/ls guidance", () => {
    const sub = join(dir, "subdir");
    mkdirSync(sub);
    const d = checkReadInput({ file_path: sub });
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.reason).toMatch(/directory/);
      expect(d.reason).toMatch(/Glob|ls/);
    }
  });

  it("allows the call through when stat fails (let SDK surface its own error)", () => {
    expect(checkReadInput({ file_path: join(dir, "nope.ts") })).toEqual({ allow: true });
  });

  it("allows the call through on missing/invalid file_path (let SDK validate)", () => {
    expect(checkReadInput({})).toEqual({ allow: true });
    expect(checkReadInput({ file_path: "" })).toEqual({ allow: true });
    expect(checkReadInput({ file_path: 123 })).toEqual({ allow: true });
  });
});
