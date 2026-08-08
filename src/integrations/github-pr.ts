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

export interface GithubRefUpdateResult {
  updated: boolean;
  message: string;
}

export interface GithubBranchUpdateResult {
  requested: boolean;
  headSha?: string;
  message: string;
}

export type GithubMergeMethod = 'merge' | 'squash' | 'rebase';
export type GithubPullRequestMergeable = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
export type GithubPullRequestMergeState =
  'BEHIND' | 'BLOCKED' | 'CLEAN' | 'DIRTY' | 'DRAFT' | 'HAS_HOOKS' | 'UNKNOWN' | 'UNSTABLE';
export type GithubPullRequestReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED';
export type GithubStatusCheckState = 'ERROR' | 'EXPECTED' | 'FAILURE' | 'PENDING' | 'SUCCESS';

/** One terminally failing context from GitHub's combined check rollup. Check
 * runs and legacy commit statuses have different schemas; this is the small,
 * provider-neutral packet the Do agent needs to identify and inspect the
 * failure without scraping an opaque merge error. */
export interface GithubFailedCheck {
  name: string;
  state: string;
  url?: string;
  detail?: string;
}

/** GitHub's live merge-policy observations. This intentionally does not reduce
 * branch rules, reviews, checks, and queue state to a local `ready` boolean. */
export interface GithubPullRequestReadiness {
  nodeId: string;
  url: string;
  state: GithubPullRequest['state'];
  draft: boolean;
  merged: boolean;
  headSha: string;
  mergeable: GithubPullRequestMergeable;
  mergeStateStatus: GithubPullRequestMergeState;
  reviewDecision?: GithubPullRequestReviewDecision;
  checks?: GithubStatusCheckState;
  /** The installed App predates CI-read permissions. `mergeStateStatus` remains
   * fail-closed, but pending and failed checks cannot be distinguished until the
   * installation owner approves the App's read-only Checks/Statuses upgrade. */
  checksUnavailable?: true;
  failedChecks?: GithubFailedCheck[];
  mergeQueueEntryId?: string;
  /** Most recent durable GitHub timeline record for removal from a native
   * merge queue. `beforeCommitSha` is the speculative merge-group commit whose
   * checks/policy produced that decision, not necessarily the PR head. */
  removedFromMergeQueue?: {
    createdAt: string;
    reason?: string;
    beforeCommitSha?: string;
  };
  autoMerge?: { enabledAt: string; mergeMethod: GithubMergeMethod };
  viewerCanEnableAutoMerge: boolean;
  viewerCanMergeAsAdmin: boolean;
}

export interface GithubAutoMergeResult {
  enabled: boolean;
  pullRequestId?: string;
  enabledAt?: string;
  mergeMethod?: GithubMergeMethod;
  message: string;
}

export interface GithubPrApiOptions {
  apiBase?: string;
  fetch?: typeof fetch;
}

/** Preserve GitHub's HTTP classification across the integration boundary so
 * callers can distinguish re-auth/user action from a transient service error. */
export class GithubApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'GithubApiError';
  }
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

  /** Historical direct-merge primitive. It binds the head SHA but GitHub's API
   * exposes no expected base SHA, so current landing first uses a native queue
   * and otherwise advances the exact validated head with force:false. */
  async merge(slug: string, number: number, headSha: string,
    mergeMethod: GithubMergeMethod = 'merge'): Promise<GithubMergeResult> {
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
  async enqueue(nodeId: string, headSha?: string): Promise<GithubMergeResult> {
    const value = await this.graphql<any>(
      'mutation($input:EnqueuePullRequestInput!){ enqueuePullRequest(input:$input){ mergeQueueEntry{ id } } }',
      { input: { pullRequestId: nodeId, ...(headSha ? { expectedHeadOid: headSha } : {}) } },
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

  /** Best-effort saga cleanup when a sibling PR fails after this participant
   * was already handed to GitHub.  A race may have merged it already; callers
   * therefore treat a refusal as an observed partial landing, never as rollback. */
  async dequeue(nodeId: string): Promise<{ withdrawn: boolean; message: string }> {
    const value = await this.graphql<any>(
      'mutation($input:DequeuePullRequestInput!){ dequeuePullRequest(input:$input){ mergeQueueEntry{ id } } }',
      { input: { pullRequestId: nodeId } },
    );
    const message = value?.errors?.[0]?.message
      ? String(value.errors[0].message)
      : 'Pull request removed from the merge queue';
    return { withdrawn: !value?.errors?.length, message };
  }

  async disableAutoMerge(nodeId: string): Promise<{ withdrawn: boolean; message: string }> {
    const value = await this.graphql<any>(
      'mutation($input:DisablePullRequestAutoMergeInput!){ disablePullRequestAutoMerge(input:$input){ pullRequest{ id autoMergeRequest{ enabledAt } } } }',
      { input: { pullRequestId: nodeId } },
    );
    const message = value?.errors?.[0]?.message
      ? String(value.errors[0].message)
      : 'Pull request auto-merge disabled';
    return { withdrawn: !value?.errors?.length, message };
  }

  /** Atomically advance a target ref to the exact candidate that CI inspected.
   * `force:false` is the compare-and-swap property we need: if the target moved
   * beyond a commit contained in `headSha`, GitHub rejects the non-fast-forward
   * update instead of manufacturing a different, unvalidated merge result. */
  async fastForwardTarget(slug: string, target: string, headSha: string): Promise<GithubRefUpdateResult> {
    const value = await this.request<any>(
      `/repos/${slug}/git/refs/heads/${target.split('/').map(encodeURIComponent).join('/')}`,
      { method: 'PATCH', body: JSON.stringify({ sha: headSha, force: false }) },
      [409, 422],
    );
    return {
      updated: Boolean(value?.ref && value?.object?.sha === headSha),
      message: String(value?.message ?? (value?.ref ? 'Target advanced to the validated pull-request head' : 'GitHub did not advance the target ref')),
    };
  }

  /** Inspect the PR state GitHub uses when deciding whether and how it may
   * merge, including reviews, checks, queue state, and viewer capabilities. */
  async readiness(slug: string, number: number): Promise<GithubPullRequestReadiness> {
    const [owner, name, ...extra] = slug.split('/');
    if (!owner || !name || extra.length) throw new Error(`Invalid GitHub repository slug: ${slug}`);
    const query = (checkLevel: 'details' | 'aggregate' | 'none') => `query PullRequestReadiness($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          id url state isDraft merged headRefOid mergeable mergeStateStatus reviewDecision
          ${checkLevel === 'none' ? '' : `statusCheckRollup {
            state
            ${checkLevel === 'details' ? `contexts(first: 50) {
              nodes {
                __typename
                ... on CheckRun {
                  databaseId name status conclusion detailsUrl
                }
                ... on StatusContext { context state targetUrl description }
              }
            }` : ''}
          }`}
          mergeQueueEntry { id }
          timelineItems(last: 10, itemTypes: [REMOVED_FROM_MERGE_QUEUE_EVENT]) {
            nodes {
              ... on RemovedFromMergeQueueEvent {
                createdAt reason beforeCommit { oid }
              }
            }
          }
          autoMergeRequest { enabledAt mergeMethod }
          viewerCanEnableAutoMerge viewerCanMergeAsAdmin
        }
      }
    }`;
    let value = await this.graphql<any>(query('details'), { owner, name, number });
    const firstError = value?.errors?.map((error: any) => String(error?.message ?? '')).join('; ') ?? '';
    // Some GitHub App installations can read the aggregate status rollup but
    // not enumerate CheckRun nodes. GitHub rejects the whole GraphQL response in
    // that case, so retry the same readiness query without optional details.
    // The gate still gets exact PENDING/FAILURE/SUCCESS state and never treats a
    // permission error as green; only names/URLs are omitted.
    if (value?.errors?.length && /resource not accessible by integration/i.test(firstError)) {
      value = await this.graphql<any>(query('aggregate'), { owner, name, number });
    }
    let checksUnavailable = false;
    const aggregateError = value?.errors?.map((error: any) => String(error?.message ?? '')).join('; ') ?? '';
    // Apps created before CI inspection was part of landing have neither the
    // Checks nor Commit-status repository permission. The rollup field itself is
    // then forbidden. Fetch the remaining policy state for diagnosis, but mark
    // CI unavailable so exact landing waits fail-closed for the installation
    // owner to approve the read-only upgrade.
    if (value?.errors?.length && /resource not accessible by integration/i.test(aggregateError)) {
      value = await this.graphql<any>(query('none'), { owner, name, number });
      checksUnavailable = true;
    }
    if (value?.errors?.length) {
      const message = value.errors.map((error: any) => String(error?.message ?? 'Unknown error')).join('; ');
      const kinds = value.errors.map((error: any) => String(error?.type ?? error?.extensions?.type ?? '').toUpperCase());
      const status = /rate.?limit|secondary limit|abuse/i.test(message)
        ? 429
        : kinds.some((kind: string) => kind === 'FORBIDDEN' || kind === 'UNAUTHORIZED')
          ? 403
          : kinds.some((kind: string) => kind === 'NOT_FOUND')
            ? 404
            : 502;
      throw new GithubApiError(status, `GitHub GraphQL: ${message.slice(0, 300)}`);
    }
    const raw = value?.data?.repository?.pullRequest;
    if (!raw) throw new GithubApiError(404, `GitHub pull request ${slug}#${number} was not found`);
    const failedCheckCandidates = (raw.statusCheckRollup?.contexts?.nodes ?? []).flatMap((node: any) => {
      if (node?.__typename === 'CheckRun') {
        const state = String(node.conclusion ?? node.status ?? 'UNKNOWN');
        if (!['ACTION_REQUIRED', 'CANCELLED', 'FAILURE', 'STALE', 'STARTUP_FAILURE', 'TIMED_OUT'].includes(state)) return [];
        return [{
          name: String(node.name ?? 'GitHub check'), state,
          ...(node.databaseId ? { databaseId: Number(node.databaseId) } : {}),
          ...(node.detailsUrl ? { url: String(node.detailsUrl) } : {}),
        }];
      }
      if (node?.__typename === 'StatusContext') {
        const state = String(node.state ?? 'UNKNOWN');
        if (!['ERROR', 'FAILURE'].includes(state)) return [];
        return [{
          name: String(node.context ?? 'GitHub status'), state,
          ...(node.targetUrl ? { url: String(node.targetUrl) } : {}),
          ...(node.description ? { detail: String(node.description).slice(0, 1200) } : {}),
        }];
      }
      return [];
    }) as Array<GithubFailedCheck & { databaseId?: number }>;
    const failedChecks = await this.enrichFailedChecks(slug, failedCheckCandidates);
    const removed = (raw.timelineItems?.nodes ?? []).filter(Boolean).at(-1);
    return {
      nodeId: String(raw.id),
      url: String(raw.url),
      state: raw.state === 'OPEN' ? 'open' : 'closed',
      draft: Boolean(raw.isDraft),
      merged: Boolean(raw.merged),
      headSha: String(raw.headRefOid),
      mergeable: raw.mergeable as GithubPullRequestMergeable,
      mergeStateStatus: raw.mergeStateStatus as GithubPullRequestMergeState,
      ...(raw.reviewDecision ? { reviewDecision: raw.reviewDecision as GithubPullRequestReviewDecision } : {}),
      ...(raw.statusCheckRollup?.state ? { checks: raw.statusCheckRollup.state as GithubStatusCheckState } : {}),
      ...(checksUnavailable ? { checksUnavailable: true as const } : {}),
      ...(failedChecks.length ? { failedChecks } : {}),
      ...(raw.mergeQueueEntry?.id ? { mergeQueueEntryId: String(raw.mergeQueueEntry.id) } : {}),
      ...(removed?.createdAt ? { removedFromMergeQueue: {
        createdAt: String(removed.createdAt),
        ...(removed.reason ? { reason: String(removed.reason) } : {}),
        ...(removed.beforeCommit?.oid ? { beforeCommitSha: String(removed.beforeCommit.oid) } : {}),
      } } : {}),
      ...(raw.autoMergeRequest ? { autoMerge: { enabledAt: String(raw.autoMergeRequest.enabledAt),
        mergeMethod: String(raw.autoMergeRequest.mergeMethod).toLowerCase() as GithubMergeMethod } } : {}),
      viewerCanEnableAutoMerge: Boolean(raw.viewerCanEnableAutoMerge),
      viewerCanMergeAsAdmin: Boolean(raw.viewerCanMergeAsAdmin),
    };
  }

  /** Failed checks for an arbitrary commit, including a temporary merge-group
   * commit that is no longer reachable through the PR head after queue
   * ejection. Both Checks and legacy commit-status providers are represented. */
  async failedChecksForRef(slug: string, ref: string): Promise<GithubFailedCheck[]> {
    const encoded = encodeURIComponent(ref);
    const [runs, combined] = await Promise.all([
      this.request<any>(`/repos/${slug}/commits/${encoded}/check-runs?per_page=100&filter=latest`)
        .catch(() => undefined),
      this.request<any>(`/repos/${slug}/commits/${encoded}/status?per_page=100`)
        .catch(() => undefined),
    ]);
    const candidates: Array<GithubFailedCheck & { databaseId?: number }> = [];
    for (const run of runs?.check_runs ?? []) {
      const state = String(run?.conclusion ?? run?.status ?? 'UNKNOWN').toUpperCase();
      if (!['ACTION_REQUIRED', 'CANCELLED', 'FAILURE', 'STALE', 'STARTUP_FAILURE', 'TIMED_OUT'].includes(state)) continue;
      candidates.push({
        name: String(run?.name ?? 'GitHub check'), state,
        ...(run?.id ? { databaseId: Number(run.id) } : {}),
        ...(run?.details_url ? { url: String(run.details_url) } : {}),
      });
    }
    for (const status of combined?.statuses ?? []) {
      const state = String(status?.state ?? 'UNKNOWN').toUpperCase();
      if (!['ERROR', 'FAILURE'].includes(state)) continue;
      candidates.push({
        name: String(status?.context ?? 'GitHub status'), state,
        ...(status?.target_url ? { url: String(status.target_url) } : {}),
        ...(status?.description ? { detail: String(status.description).slice(0, 1200) } : {}),
      });
    }
    return this.enrichFailedChecks(slug, candidates);
  }

  /** CheckRun summary/text fields are permission-sensitive in GraphQL. Fetch
   * them and the concrete file annotations separately so a Do agent receives
   * the complete provider diagnostic whenever GitHub makes it available. */
  private async enrichFailedChecks(slug: string,
    candidates: Array<GithubFailedCheck & { databaseId?: number }>): Promise<GithubFailedCheck[]> {
    for (const check of candidates) {
      if (!check.databaseId) continue;
      const run = await this.request<any>(`/repos/${slug}/check-runs/${check.databaseId}`)
        .catch(() => undefined);
      const output = run?.output
        ? [run.output.title, run.output.summary, run.output.text]
          .map((value) => typeof value === 'string' ? value.trim() : '')
          .filter(Boolean).join('\n')
        : '';
      const annotations = await this.request<any[]>(
        `/repos/${slug}/check-runs/${check.databaseId}/annotations?per_page=100`,
      ).catch(() => undefined);
      const rendered = (Array.isArray(annotations) ? annotations : []).map((annotation) => {
        const location = annotation.path
          ? `${annotation.path}${annotation.start_line ? `:${annotation.start_line}` : ''}`
          : undefined;
        const message = [annotation.title, annotation.message, annotation.raw_details]
          .map((value) => typeof value === 'string' ? value.trim() : '').filter(Boolean).join(' — ');
        return `${location ? `${location}: ` : ''}${message || annotation.annotation_level || 'check annotation'}`;
      }).join('\n');
      check.detail = [check.detail, output, rendered].filter(Boolean).join('\n').slice(0, 24_000);
    }
    return candidates.map(({ databaseId: _databaseId, ...check }) => check);
  }

  /** Enable GitHub auto-merge only while the PR still points at `headSha`. */
  async enableAutoMerge(nodeId: string, headSha: string,
    mergeMethod: GithubMergeMethod = 'merge'): Promise<GithubAutoMergeResult> {
    const value = await this.graphql<any>(`mutation EnablePullRequestAutoMerge($input: EnablePullRequestAutoMergeInput!) {
      enablePullRequestAutoMerge(input: $input) {
        pullRequest { id autoMergeRequest { enabledAt mergeMethod } }
      }
    }`, { input: { pullRequestId: nodeId, expectedHeadOid: headSha, mergeMethod: mergeMethod.toUpperCase() } });
    const raw = value?.data?.enablePullRequestAutoMerge?.pullRequest;
    const request = raw?.autoMergeRequest;
    return {
      enabled: Boolean(request),
      ...(raw?.id ? { pullRequestId: String(raw.id) } : {}),
      ...(request?.enabledAt ? { enabledAt: String(request.enabledAt) } : {}),
      ...(request?.mergeMethod ? { mergeMethod: String(request.mergeMethod).toLowerCase() as GithubMergeMethod } : {}),
      message: value?.errors?.[0]?.message
        ? String(value.errors[0].message)
        : request ? 'Pull request auto-merge enabled' : 'GitHub did not enable pull request auto-merge',
    };
  }

  /** Ask GitHub to merge the current base into a merely-behind PR branch. This
   * is mechanical and expected-head guarded: a real conflict is returned to the
   * caller, while a racing writer gets a 422 rather than being overwritten. */
  async updateBranch(slug: string, number: number, expectedHeadSha: string): Promise<GithubBranchUpdateResult> {
    const value = await this.request<any>(`/repos/${slug}/pulls/${number}/update-branch`, {
      method: 'PUT', body: JSON.stringify({ expected_head_sha: expectedHeadSha }),
    }, [422]);
    const message = String(value?.message ?? 'GitHub accepted the pull-request branch update');
    if (/conflict|expected head|head sha|not mergeable|cannot be updated/i.test(message))
      return { requested: false, message };

    // The endpoint is asynchronous. Usually the ref moves immediately; waiting
    // briefly here lets the activity return the new reviewed identity instead of
    // misclassifying GitHub's own update as an external branch replacement on
    // the next reconciliation pass.
    for (let attempt = 0; attempt < 20; attempt++) {
      const current = await this.get(slug, number);
      if (current.headSha && current.headSha !== expectedHeadSha)
        return { requested: true, headSha: current.headSha, message };
      if (attempt < 19) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return { requested: true, message };
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
    if (!response.ok && !accepted.includes(response.status))
      throw new GithubApiError(response.status, `GitHub API ${response.status}: ${(await response.text()).slice(0, 300)}`);
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
  if (event === 'check_run') {
    const taskId = taskIdOfBranch(payload?.check_run?.check_suite?.head_branch);
    if (!taskId || payload?.action !== 'completed') return undefined;
    const run = payload.check_run;
    return { taskId, type: 'github.check.completed', payload: {
      name: String(run.name ?? 'GitHub check'),
      conclusion: String(run.conclusion ?? ''),
      status: String(run.status ?? ''),
      branch: String(run.check_suite.head_branch),
      ...(run.details_url ? { url: String(run.details_url) } : {}),
      ...(payload?.repository?.full_name ? { repo: String(payload.repository.full_name) } : {}),
    } };
  }
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
