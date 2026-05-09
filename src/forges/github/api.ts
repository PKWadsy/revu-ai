/**
 * Thin `fetch`-based GitHub REST API client. Exposes only the four endpoints
 * the forge adapter uses; not a general-purpose SDK.
 */

const BASE = "https://api.github.com";
const ACCEPT_JSON = "application/vnd.github+json";
const ACCEPT_DIFF = "application/vnd.github.v3.diff";
const API_VERSION = "2022-11-28";

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH";
  accept?: string;
  body?: unknown;
  fetchImpl?: typeof fetch;
}

export interface GhPullRequest {
  number: number;
  head: { sha: string; ref: string };
  base: { sha: string; ref: string };
}

export interface GhComment {
  id: number;
  body: string;
  user: { login: string; type: string } | null;
  path?: string;
  line?: number;
}

export interface GhPostReviewBody {
  commit_id: string;
  event: "COMMENT" | "REQUEST_CHANGES" | "APPROVE";
  body: string;
  comments: Array<{
    path: string;
    line: number;
    side: "LEFT" | "RIGHT";
    body: string;
    start_line?: number;
    start_side?: "LEFT" | "RIGHT";
  }>;
}

export interface GhCreatedReview {
  id: number;
  html_url: string;
  state: string;
}

export class GitHubApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly responseBody: string,
  ) {
    super(`GitHub API ${status} for ${url}: ${responseBody.slice(0, 400)}`);
    this.name = "GitHubApiError";
  }
}

export class GitHubClient {
  constructor(private readonly token: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async getPullRequest(owner: string, repo: string, number: number): Promise<GhPullRequest> {
    return this.request<GhPullRequest>(`/repos/${owner}/${repo}/pulls/${number}`);
  }

  async getPullRequestDiff(owner: string, repo: string, number: number): Promise<string> {
    return this.requestText(`/repos/${owner}/${repo}/pulls/${number}`, { accept: ACCEPT_DIFF });
  }

  /** Paged fetch of PR review comments (the inline ones). */
  async listReviewComments(owner: string, repo: string, number: number): Promise<GhComment[]> {
    return this.listAll<GhComment>(`/repos/${owner}/${repo}/pulls/${number}/comments`);
  }

  /** Paged fetch of the comments that belong to a single PR review (created together). */
  async listReviewCommentsForReview(
    owner: string,
    repo: string,
    number: number,
    reviewId: number,
  ): Promise<GhComment[]> {
    return this.listAll<GhComment>(
      `/repos/${owner}/${repo}/pulls/${number}/reviews/${reviewId}/comments`,
    );
  }

  /** Paged fetch of issue comments — used to find a prior top-level body marker. */
  async listIssueComments(owner: string, repo: string, number: number): Promise<GhComment[]> {
    return this.listAll<GhComment>(`/repos/${owner}/${repo}/issues/${number}/comments`);
  }

  async createReview(
    owner: string,
    repo: string,
    number: number,
    body: GhPostReviewBody,
  ): Promise<GhCreatedReview> {
    return this.request<GhCreatedReview>(`/repos/${owner}/${repo}/pulls/${number}/reviews`, {
      method: "POST",
      body,
    });
  }

  /** Edit an existing PR review comment's body and/or line. */
  async patchReviewComment(
    owner: string,
    repo: string,
    commentId: number,
    body: { body: string },
  ): Promise<GhComment> {
    return this.request<GhComment>(`/repos/${owner}/${repo}/pulls/comments/${commentId}`, {
      method: "PATCH",
      body,
    });
  }

  private async listAll<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    const perPage = 100;
    let page = 1;
    // GitHub paginates via Link header; fewer-than-per-page is a reliable end-of-list signal.
    for (;;) {
      const sep = path.includes("?") ? "&" : "?";
      const batch = await this.request<T[]>(`${path}${sep}per_page=${perPage}&page=${page}`);
      out.push(...batch);
      if (batch.length < perPage) break;
      page++;
      if (page > 100) break; // hard safety cap
    }
    return out;
  }

  private async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const text = await this.requestText(path, opts);
    return JSON.parse(text) as T;
  }

  private async requestText(path: string, opts: RequestOptions = {}): Promise<string> {
    const url = path.startsWith("http") ? path : `${BASE}${path}`;
    const headers: Record<string, string> = {
      Accept: opts.accept ?? ACCEPT_JSON,
      Authorization: `Bearer ${this.token}`,
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "revu-ai",
    };
    const init: RequestInit = { method: opts.method ?? "GET", headers };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    const fetchFn = opts.fetchImpl ?? this.fetchImpl;
    const res = await fetchFn(url, init);
    const body = await res.text();
    if (!res.ok) {
      throw new GitHubApiError(res.status, url, body);
    }
    return body;
  }
}
