import { describe, it, expect } from "vitest";
import {
  bodyFingerprint,
  extractBodyMarker,
  extractMarkers,
  fingerprint,
  withBodyMarker,
  withMarker,
} from "../../src/forges/dedup.js";
import type { Finding } from "../../src/types.js";

const F: Finding = {
  ruleId: "dead-code",
  severity: "high",
  path: "src/foo.ts",
  line: 42,
  message: "unused export `foo`",
};

describe("fingerprint", () => {
  it("is stable across calls for the same finding", () => {
    expect(fingerprint(F)).toBe(fingerprint(F));
  });

  it("changes when ruleId changes", () => {
    expect(fingerprint(F)).not.toBe(fingerprint({ ...F, ruleId: "other" }));
  });

  it("changes when path changes", () => {
    expect(fingerprint(F)).not.toBe(fingerprint({ ...F, path: "src/bar.ts" }));
  });

  it("changes when line changes", () => {
    expect(fingerprint(F)).not.toBe(fingerprint({ ...F, line: 43 }));
  });

  it("changes when message changes", () => {
    expect(fingerprint(F)).not.toBe(fingerprint({ ...F, message: "different" }));
  });

  it("treats undefined line as distinct from line=0", () => {
    const a = fingerprint({ ...F, line: undefined });
    const b = fingerprint({ ...F, line: 0 });
    expect(a).not.toBe(b);
  });

  it("returns a 12-char hex string", () => {
    expect(fingerprint(F)).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("withMarker / extractMarkers", () => {
  it("round-trips a single marker", () => {
    const fp = fingerprint(F);
    const body = withMarker("hello world", fp);
    expect(extractMarkers(body)).toEqual([fp]);
  });

  it("extracts every marker in a body that contains multiple", () => {
    const a = withMarker("a", "aaaaaaaaaaaa");
    const b = withMarker("b", "bbbbbbbbbbbb");
    const merged = `${a}\n\n${b}`;
    expect(extractMarkers(merged).sort()).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
  });

  it("returns [] for a body with no marker", () => {
    expect(extractMarkers("plain comment")).toEqual([]);
  });

  it("ignores HTML comments that aren't ours", () => {
    expect(extractMarkers("<!-- coderabbitai:thing=abc -->")).toEqual([]);
  });
});

describe("body marker", () => {
  it("round-trips", () => {
    const bfp = bodyFingerprint(["abc123def456", "fedcba987654"]);
    const body = withBodyMarker("hello", bfp);
    expect(extractBodyMarker(body)).toBe(bfp);
  });

  it("is order-independent", () => {
    const a = bodyFingerprint(["abc123def456", "fedcba987654"]);
    const b = bodyFingerprint(["fedcba987654", "abc123def456"]);
    expect(a).toBe(b);
  });

  it("is empty-input stable", () => {
    expect(bodyFingerprint([])).toBe(bodyFingerprint([]));
  });
});
