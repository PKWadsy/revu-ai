import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";

function freshRepo(): string {
  return mkdtempSync(join(tmpdir(), "revu-config-"));
}

describe("loadConfig — gateOn", () => {
  it("defaults gateOn to the default failOn (high)", () => {
    const dir = freshRepo();
    try {
      const cfg = loadConfig(dir, {});
      expect(cfg.failOn).toBe("high");
      expect(cfg.gateOn).toBe("high");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls gateOn back to an explicit failOn when --gate-on is absent", () => {
    const dir = freshRepo();
    try {
      const cfg = loadConfig(dir, { failOn: "low" });
      expect(cfg.gateOn).toBe("low");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses an explicit gateOn over failOn", () => {
    const dir = freshRepo();
    try {
      const cfg = loadConfig(dir, { failOn: "low", gateOn: "high" });
      expect(cfg.failOn).toBe("low");
      expect(cfg.gateOn).toBe("high");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an invalid gateOn value", () => {
    const dir = freshRepo();
    try {
      expect(() => loadConfig(dir, { gateOn: "banana" })).toThrow(/gate-on/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("CLI --fail-on overrides a config-file gateOn when --gate-on is absent", () => {
    const dir = freshRepo();
    try {
      writeFileSync(join(dir, "revu.config.json"), JSON.stringify({ gateOn: "medium" }));
      const cfg = loadConfig(dir, { failOn: "low" });
      // No --gate-on supplied → fallback drags the gate to the CLI failOn, not the file's "medium".
      expect(cfg.gateOn).toBe("low");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
