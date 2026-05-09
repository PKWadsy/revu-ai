import { createHash } from "node:crypto";
import type { Finding } from "./types.js";

/**
 * Stable 12-char hash that identifies a finding across runs.
 * Computed from (ruleId, path, line, message) so that the same logical
 * issue at the same logical place always hashes to the same value.
 */
export function computeFingerprint(input: {
  ruleId: string;
  path: string;
  line?: number;
  message: string;
}): string {
  const h = createHash("sha256");
  h.update(input.ruleId);
  h.update("\0");
  h.update(input.path);
  h.update("\0");
  h.update(input.line === undefined ? "" : String(input.line));
  h.update("\0");
  h.update(input.message);
  return h.digest("hex").slice(0, 12);
}

/** Return a Finding with its `fingerprint` populated, computing it if missing. */
export function ensureFingerprint<T extends Omit<Finding, "fingerprint"> & { fingerprint?: string }>(
  f: T,
): T & { fingerprint: string } {
  return { ...f, fingerprint: f.fingerprint ?? computeFingerprint(f) };
}
