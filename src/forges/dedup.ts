import { createHash } from "node:crypto";
import type { Finding } from "../types.js";
import { computeFingerprint } from "../findings.js";

const MARKER_PREFIX = "revu-ai:fp=";
const MARKER_RE = /<!--\s*revu-ai:fp=([0-9a-f]{12})\s*-->/g;
const BODY_MARKER_PREFIX = "revu-ai:body-fp=";
const BODY_MARKER_RE = /<!--\s*revu-ai:body-fp=([0-9a-f]{12})\s*-->/;

/** Stable 12-char hash of a finding's identity. Prefer reading `finding.fingerprint` directly
 *  on `Finding` objects coming from the runtime; this helper is for cases where the field
 *  may be absent (e.g. test fixtures, ad-hoc finding-shaped objects). */
export function fingerprint(finding: Pick<Finding, "ruleId" | "path" | "line" | "message"> & { fingerprint?: string }): string {
  return finding.fingerprint ?? computeFingerprint(finding);
}

/** Stable 12-char hash of the *set* of fingerprints in a single run's body, used to short-circuit identical re-posts. */
export function bodyFingerprint(fingerprints: Iterable<string>): string {
  const sorted = [...fingerprints].sort();
  const h = createHash("sha256");
  h.update(sorted.join("|"));
  return h.digest("hex").slice(0, 12);
}

/** Append a hidden HTML comment marker to a comment body. */
export function withMarker(body: string, fp: string): string {
  return `${body.replace(/\s+$/u, "")}\n\n<!-- ${MARKER_PREFIX}${fp} -->`;
}

/** Append a hidden HTML body-level marker to the top-level review body. */
export function withBodyMarker(body: string, bodyFp: string): string {
  return `${body.replace(/\s+$/u, "")}\n\n<!-- ${BODY_MARKER_PREFIX}${bodyFp} -->`;
}

/** Extract every revu-ai:fp marker from a comment body. */
export function extractMarkers(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(MARKER_RE)) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

/** Extract a body-level marker, if present. */
export function extractBodyMarker(body: string): string | undefined {
  const m = body.match(BODY_MARKER_RE);
  return m?.[1];
}
