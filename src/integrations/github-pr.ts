/**
 * GitHub pull requests — the optional integration output of the PR stage
 * (SPEC §5.2, PLAN-git-config.md §5 `remote: 'pr'`).
 *
 * Everything here speaks the REST API with a bearer token, deliberately *not*
 * the `gh` CLI: the token is already resolvable (user App authorization for
 * human work; installation/profile/host fallback for automation/compatibility),
 * and the API is the same call from a worktree world, a cloud world,
 * or the host — so PR behavior no longer depends on a binary being installed in
 * whatever environment happens to run the activity. Human work supplies a
 * refreshable GitHub App user token; installation/static tokens remain valid
 * for automation and compatibility callers.
 */

export interface GithubPullRequest {
  number: number;
  nodeId?: string;
  url: string;
  state: 'open' | 'closed';
  merged: boolean;
  title?: string;
  head?: string;
  headSha?: string;
  base?: string;
  mergeable?: boolean | null;
  mergeableState?: string;
  mergeCommitSha?: string;
}

export interface GithubMergeResult {
  merged: boolean;
  sha?: string;
  message: string;
  /** GitHub accepted the PR into its merge queue. */
  queued?: boolean;
}

export interface GithubPrApiOptions {
  apiBase?: string;
  fetch?: typeof fetch;
}

/** A refreshable GitHub App user authorization. A forced resolution follows a
 * 401, which is safe to retry because GitHub rejected the request before
 * executing it. Static PAT/App-token callers retain the string form. */
export type GithubTokenProvider = (options?: { forceRefresh?: boolean }) => Promise<string>;

/** `owner/name` for a GitHub remote (ssh, https, or `git@`), else undefined. */
export function githubSlug(remote: string): string | undefined {
  const match = remote.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/i);
  return match?.[1];
}

/** The task branch a PR head belongs to, for correlating GitHub back to karmax. */
export function taskIdOfBranch(branch: string | undefined): string | undefined {
  const match = branch?.match(/^karmax\/(.+)$/);
  return match?.[1];
}

function normalize(raw: any): GithubPullRequest {
  return {
    number: Number(raw.number),
    ...(raw.node_id ? { nodeId: String(raw.node_id) } : {}),
    url: String(raw.html_url ?? raw.url ?? ''),
    state: raw.state === 'closed' ? 'closed' : 'open',
    merged: Boolean(raw.merged ?? raw.merged_at),
    ...(raw.title ? { title: String(raw.title) } : {}),
    ...(raw.head?.ref ? { head: String(raw.head.ref) } : {}),
    ...(raw.head?.sha ? { headSha: String(raw.head.sha) } : {}),
    ...(raw.base?.ref ? { base: String(raw.base.ref) } : {}),
    ...(Object.prototype.hasOwnProperty.call(raw, 'mergeable') ? { mergeable: raw.mergeable == null ? null : Boolean(raw.mergeable) } : {}),
    ...(raw.mergeable_state ? { mergeableState: String(raw.mergeable_state) } : {}),
    ...(raw.merge_commit_sha ? { mergeCommitSha: String(raw.merge_commit_sha) } : {}),
  };
}

export class GithubPrApi {
  private fetcher: typeof fetch;
  private apiBase: string;

  constructor(private token: string | GithubTokenProvider, options: GithubPrApiOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.apiBase = (options.apiBase ?? 'https://api.github.com').replace(/\/$/, '');
  }

  async get(slug: string, number: number): Promise<GithubPullRequest> {
    return normalize(await this.request(`/repos/${slug}/pulls/${number}`));
  }

  /** The open-or-closed PR for a head branch in the same repository, if any. */
  async findByHead(slug: string, branch: string): Promise<GithubPullRequest | undefined> {
    const owner = slug.split('/')[0];
    const found = await this.request<any[]>(
      `/repos/${slug}/pulls?state=all&per_page=1&head=${encodeURIComponent(`${owner}:${branch}`)}`);
    return found?.length ? normalize(found[0]) : undefined;
  }

  /**
   * The idempotent primitive the PR stage needs: one PR per task branch, whose
   * title/body track the task. A retried stage (or a follow-up that reopened
   * Do) must update that PR, never fail on GitHub's "already exists" 422 and
   * never open a second one.
   */
  async openOrUpdate(slug: string, input: { head: string; base: string; title: string; body: string }):
  Promise<{ pr: GithubPullRequest; created: boolean }> {
    const existing = await this.findByHead(slug, input.head);
    if (existing) {
      const pr = await this.update(slug, existing.number, {
        title: input.title, body: input.body, base: input.base,
        // A PR closed without merging is reopened: the task is live again.
        ...(existing.state === 'closed' && !existing.merged ? { state: 'open' as const } : {}),
      });
      return { pr, created: false };
    }
    try {
      return { pr: normalize(await this.request(`/repos/${slug}/pulls`, {
        method: 'POST',
        body: JSON.stringify({ title: input.title, body: input.body, head: input.head, base: input.base }),
      })), created: true };
    } catch (error) {
      // Lost a race (or GitHub indexed the head late) — adopt the existing PR.
      const raced = await this.findByHead(slug, input.head).catch(() => undefined);
      if (!raced) throw error;
      return { pr: raced, created: false };
    }
  }

  async update(slug: string, number: number,
    patch: { title?: string; body?: string; base?: string; state?: 'open' | 'closed' }): Promise<GithubPullRequest> {
    return normalize(await this.request(`/repos/${slug}/pulls/${number}`, {
      method: 'PATCH', body: JSON.stringify(patch),
    }));
  }

  async comment(slug: string, number: number, body: string): Promise<void> {
    await this.request(`/repos/${slug}/issues/${number}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
  }

  /** Mirror an explicit krmax Human-confirm decision into GitHub's native PR
   * review record. GitHub may reject self-approval or an already-settled review;
   * callers treat that as non-fatal and let repository policy decide at merge. */
  async approve(slug: string, number: number, headSha: string, body: string): Promise<void> {
    await this.request(`/repos/${slug}/pulls/${number}/reviews`, {
      method: 'POST', body: JSON.stringify({ commit_id: headSha, event: 'APPROVE', body }),
    });
  }

  /** Ask GitHub to merge this exact reviewed head. GitHub remains the policy
   * authority: branch protection, rulesets, required reviews and checks are all
   * enforced by this endpoint. A moved head cannot be merged accidentally. */
  async merge(slug: string, number: number, headSha: string,
    mergeMethod: 'merge' | 'squash' | 'rebase' = 'merge'): Promise<GithubMergeResult> {
    const value = await this.request<any>(`/repos/${slug}/pulls/${number}/merge`, {
      method: 'PUT',
      body: JSON.stringify({ sha: headSha, merge_method: mergeMethod }),
    }, [405, 409, 422]);
    return {
      merged: Boolean(value?.merged),
      ...(value?.sha ? { sha: String(value.sha) } : {}),
      message: String(value?.message ?? (value?.merged ? 'Pull request merged' : 'GitHub did not merge the pull request')),
    };
  }

  /** Repositories configured with GitHub merge queues reject the direct REST
   * merge. Enqueue the same PR through GraphQL; a mutation error simply means
   * this repository is not queue-enabled (or its current policy is unmet). */
  async enqueue(nodeId: string): Promise<GithubMergeResult> {
    const value = await this.graphql<any>(
      'mutation($id:ID!){ enqueuePullRequest(input:{pullRequestId:$id}){ mergeQueueEntry{ id } } }',
      { id: nodeId },
    );
    return {
      merged: false,
      queued: Boolean(value?.data?.enqueuePullRequest?.mergeQueueEntry?.id),
      message: value?.errors?.[0]?.message
        ? String(value.errors[0].message)
        : value?.data?.enqueuePullRequest?.mergeQueueEntry?.id
          ? 'Pull request queued for merge'
          : 'GitHub did not queue the pull request',
    };
  }

  private async graphql<T = any>(query: string, variables: Record<string, unknown>): Promise<T> {
    return this.request<T>('/graphql', { method: 'POST', body: JSON.stringify({ query, variables }) });
  }

  private async request<T = any>(pathname: string, init: RequestInit = {}, accepted: number[] = []): Promise<T> {
    const send = async (forceRefresh = false) => {
      const token = typeof this.token === 'function'
        ? await this.token(forceRefresh ? { forceRefresh: true } : undefined)
        : this.token;
      return this.fetcher(`${this.apiBase}${pathname}`, { ...init, headers: {
        accept: 'application/vnd.github+json', authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28', 'content-type': 'application/json',
        'user-agent': 'karmax', ...(init.headers ?? {}),
      } });
    };
    let response = await send();
    if (response.status === 401 && typeof this.token === 'function') response = await send(true);
    if (!response.ok && !accepted.includes(response.status)) throw new Error(`GitHub API ${response.status}: ${(await response.text()).slice(0, 300)}`);
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

/** A karmax event minted from a GitHub PR webhook delivery, correlated to the
 *  task whose branch the PR heads (SPEC §5.4 — the dispatcher's GitHub feed). */
export interface GithubPrWebhookEvent {
  taskId: string;
  type: string;
  payload: Record<string, unknown>;
}

/**
 * Normalize a `pull_request` / `pull_request_review` delivery into the karmax
 * event a trigger can match (`github.pr.merged`, `github.pr.closed`,
 * `github.pr.review`, …). Only PRs whose head is a karmax task branch produce
 * events: those are the ones that belong to a task's timeline.
 */
export function pullRequestWebhookEvent(event: string, payload: any): GithubPrWebhookEvent | undefined {
  const pr = payload?.pull_request;
  const taskId = taskIdOfBranch(pr?.head?.ref);
  if (!taskId) return undefined;
  const base = {
    number: Number(pr.number),
    url: String(pr.html_url ?? ''),
    repo: String(payload?.repository?.full_name ?? ''),
    branch: String(pr.head.ref),
    target: String(pr.base?.ref ?? ''),
    state: pr.state === 'closed' ? 'closed' : 'open',
    merged: Boolean(pr.merged ?? pr.merged_at),
    ...(pr.title ? { title: String(pr.title) } : {}),
  };
  if (event === 'pull_request') {
    // "merged" is an action in karmax's vocabulary even though GitHub folds it
    // into `closed` — it is the outcome triggers actually care about.
    const action = payload.action === 'closed' && base.merged ? 'merged' : String(payload.action ?? '');
    if (!action) return undefined;
    return { taskId, type: `github.pr.${action}`, payload: { ...base, action } };
  }
  if (event === 'pull_request_review') {
    const review = String(payload?.review?.state ?? '').toLowerCase();
    if (!review) return undefined;
    return { taskId, type: 'github.pr.review', payload: { ...base, review,
      ...(payload.review?.user?.login ? { reviewer: String(payload.review.user.login) } : {}) } };
  }
  return undefined;
}
