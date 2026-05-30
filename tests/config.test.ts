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

  it("honors a config-file gateOn over the --fail-on fallback", () => {
    const dir = freshRepo();
    try {
      writeFileSync(join(dir, "revu.config.json"), JSON.stringify({ gateOn: "medium" }));
      // No --gate-on supplied. An explicit config-file gateOn must win over the
      // failOn-derived default — gateOn is not silently dragged to the CLI failOn.
      const cfg = loadConfig(dir, { failOn: "low" });
      expect(cfg.gateOn).toBe("medium");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses a config-file gateOn when no CLI gate/fail flags are given", () => {
    const dir = freshRepo();
    try {
      writeFileSync(join(dir, "revu.config.json"), JSON.stringify({ gateOn: "critical" }));
      const cfg = loadConfig(dir, {});
      expect(cfg.gateOn).toBe("critical");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("CLI --gate-on overrides a config-file gateOn", () => {
    const dir = freshRepo();
    try {
      writeFileSync(join(dir, "revu.config.json"), JSON.stringify({ gateOn: "medium" }));
      const cfg = loadConfig(dir, { gateOn: "critical" });
      expect(cfg.gateOn).toBe("critical");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
