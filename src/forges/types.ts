import type { RunReport, Severity } from "../types.js";

export interface ForgeContext {
  repo: { owner: string; name: string };
  pr: number;
  headSha: string;
  baseSha?: string;
  token: string;
}

export interface PostOptions {
  report: RunReport;
  /** Prior run's report (the one previously written to --output-file). When present,
   *  the post step PATCHes existing comments instead of always creating fresh ones. */
  priorReport?: RunReport;
  context: ForgeContext;
  /** If any finding's severity is at or above this threshold, the review is submitted as the forge's "request changes" event. */
  requestChangesAtOrAbove?: Severity;
  dryRun: boolean;
}

export interface PostResult {
  /** URL of the review/MR comment created, when applicable. */
  reviewUrl?: string;
  inline: { posted: number; skipped: number };
  /** Top-level body / summary comment. */
  body: { posted: number; skipped: number };
  /** PATCH counts split out so the CLI can show "n resolved, m moved". */
  patchesResolved: number;
  patchesMoved: number;
  totalFindings: number;
  /** Forge-agnostic event label. The forge adapter maps this to its native enum. */
  event: "comment" | "request-changes" | "approve";
  /** The current report augmented with newly-populated commentIds and the next-run cache
   *  shape (outputFindings + outputResolutions baked into report.findings/resolutions).
   *  The CLI writes this to --output-file. */
  augmentedReport: RunReport;
}

export interface ExistingComment {
  /** The fingerprint extracted from the hidden HTML marker, if present. */
  fingerprint?: string;
  /** Forge-native comment id, opaque to callers. */
  externalId: string | number;
}

export interface ResolveContextFlags {
  pr?: string;
  repo?: string;
  commitSha?: string;
  tokenEnv?: string;
}

export interface ForgeAdapter {
  readonly name: string;
  /** Resolve `{ repo, pr, headSha, baseSha, token }` from environment + CLI flags. */
  resolveContext(env: NodeJS.ProcessEnv, flags: ResolveContextFlags): Promise<ForgeContext>;
  post(options: PostOptions): Promise<PostResult>;
}

export interface ForgeAdapterFactory {
  (): ForgeAdapter;
}
