import { afterEach, describe, expect, it, vi } from 'vitest';
import { GithubApiError, GithubPrApi, githubPrWebhookObservationKey, pullRequestWebhookEvent } from '../src/integrations/github-pr.js';

/**
 * The GitHub pull-request client's decisions against a scripted API (CI-38h):
 * which request it makes, and what it concludes from each answer GitHub can
 * give, including the unhappy ones. github-pr.test.ts covers the PR stage and
 * merge activities end to end with an in-memory GitHub; github-live.test.ts
 * covers GitHub's real rules.
 */

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

type Route = (method: string, path: string, body: any) => Response | undefined;
const json = (status: number, value: unknown) => new Response(value === undefined ? null : JSON.stringify(value), { status });

function github(...routes: Route[]) {
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    const u = new URL(String(url));
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const path = `${u.pathname}${u.search}`;
    calls.push({ method, path, body });
    for (const route of routes) {
      const response = route(method, path, body);
      if (response) return response;
    }
    return json(404, { message: `unscripted ${method} ${path}` });
  });
  return { api: new GithubPrApi('token', { fetch: fetcher as typeof fetch }), calls, fetcher };
}

const on = (method: string, path: string | RegExp, reply: (body: any) => Response): Route =>
  (m, p, body) => m === method && (typeof path === 'string' ? p === path : path.test(p)) ? reply(body) : undefined;
const pr = (number: number, fields: Record<string, unknown> = {}) => ({ number, html_url: `https://github.com/acme/app/pull/${number}`,
  state: 'open', head: { ref: 'karmax/t', sha: 'h'.repeat(40) }, base: { ref: 'main' }, ...fields });
const SLUG = 'acme/app';

describe('GitHub PR client', () => {
  it('validates the repository slug of every call before any request', async () => {
    const { api, calls } = github();
    const bad = 'acme/app/../../orgs/victim';
    const attempts: Array<() => Promise<unknown>> = [
      () => api.get(bad, 1), () => api.findByHead(bad, 'b'), () => api.update(bad, 1, { title: 'x' }),
      () => api.comment(bad, 1, 'x'), () => api.commentOnce(bad, 1, 'x', 'key'), () => api.approve(bad, 1, 'sha', 'x'),
      () => api.merge(bad, 1, 'sha'), () => api.fastForwardTarget(bad, 'main', 'sha'), () => api.readiness(bad, 1),
      () => api.failedChecksForRef(bad, 'sha'), () => api.updateBranch(bad, 1, 'sha'),
      () => api.openOrUpdate(bad, { head: 'b', base: 'main', title: 't', body: 'b' }),
    ];
    for (const attempt of attempts) await expect(attempt()).rejects.toThrow(/repository slug/);
    expect(calls).toEqual([]);
  });

  it('opens a fresh PR for new commits on a branch whose previous PR merged', async () => {
    const { api, calls } = github(
      on('GET', /\/pulls\?state=all/, () => json(200, [pr(1, { state: 'closed', merged_at: '2026-09-01T00:00:00Z' })])),
      on('GET', '/repos/acme/app/compare/main...karmax%2Ft', () => json(200, { ahead_by: 2 })),
      on('POST', '/repos/acme/app/pulls', () => json(201, pr(2))),
    );
    const result = await api.openOrUpdate(SLUG, { head: 'karmax/t', base: 'main', title: 'T', body: 'B' });
    expect(result).toMatchObject({ created: true, pr: { number: 2, state: 'open', merged: false } });
    expect(calls.at(-1)).toMatchObject({ method: 'POST', body: { title: 'T', body: 'B', head: 'karmax/t', base: 'main' } });
  });

  it('keeps a merged PR when the branch has nothing new, and refuses an unreadable comparison', async () => {
    const merged = pr(1, { state: 'closed', merged: true });
    const same = github(on('GET', /\/pulls\?state=all/, () => json(200, [merged])),
      on('GET', /\/compare\//, () => json(200, { ahead_by: 0 })));
    expect(await same.api.openOrUpdate(SLUG, { head: 'karmax/t', base: 'main', title: 'T', body: 'B' }))
      .toMatchObject({ created: false, pr: { number: 1, merged: true } });
    const garbled = github(on('GET', /\/pulls\?state=all/, () => json(200, [merged])),
      on('GET', /\/compare\//, () => json(200, { ahead_by: 'lots' })));
    await expect(garbled.api.openOrUpdate(SLUG, { head: 'karmax/t', base: 'main', title: 'T', body: 'B' }))
      .rejects.toThrow('GitHub did not report whether the branch contains new commits');
    expect(garbled.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('replaces a closed PR GitHub cannot reopen, but surfaces any other update failure', async () => {
    // GitHub refuses a base change on a closed PR (task 387), so it is reopened on its own first.
    const reopened = github(on('GET', /\/pulls\?state=all/, () => json(200, [pr(1, { state: 'closed' })])),
      on('PATCH', '/repos/acme/app/pulls/1', (body) => json(200, pr(1, { state: 'open', ...(body.title ? { title: body.title } : {}) }))));
    expect(await reopened.api.openOrUpdate(SLUG, { head: 'karmax/t', base: 'main', title: 'T', body: 'B' }))
      .toMatchObject({ created: false, pr: { number: 1, state: 'open' } });
    expect(reopened.calls.filter((call) => call.method === 'PATCH').map((call) => call.body))
      .toEqual([{ state: 'open' }, { title: 'T', body: 'B', base: 'main' }]);

    const closed = github(on('GET', /\/pulls\?state=all/, () => json(200, [pr(1, { state: 'closed' })])),
      on('PATCH', '/repos/acme/app/pulls/1', () => json(422, { message: 'state cannot be changed' })),
      on('POST', '/repos/acme/app/pulls', () => json(201, pr(3))));
    expect(await closed.api.openOrUpdate(SLUG, { head: 'karmax/t', base: 'main', title: 'T', body: 'B' }))
      .toMatchObject({ created: true, pr: { number: 3 } });
    expect(closed.calls.filter((call) => call.method === 'PATCH').map((call) => call.body)).toEqual([{ state: 'open' }]);

    // Only GitHub's refusal means "cannot reopen": a transient failure must not duplicate the PR.
    const flaky = github(on('GET', /\/pulls\?state=all/, () => json(200, [pr(1, { state: 'closed' })])),
      on('PATCH', '/repos/acme/app/pulls/1', () => json(502, { message: 'bad gateway' })));
    await expect(flaky.api.openOrUpdate(SLUG, { head: 'karmax/t', base: 'main', title: 'T', body: 'B' }))
      .rejects.toMatchObject({ name: 'GithubApiError', status: 502 });
    expect(flaky.calls.some((call) => call.method === 'POST')).toBe(false);

    const outage = github(on('GET', /\/pulls\?state=all/, () => json(200, [pr(1)])),
      on('PATCH', '/repos/acme/app/pulls/1', () => json(502, { message: 'bad gateway' })));
    await expect(outage.api.openOrUpdate(SLUG, { head: 'karmax/t', base: 'main', title: 'T', body: 'B' }))
      .rejects.toMatchObject({ name: 'GithubApiError', status: 502 });
    expect(outage.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('adopts only an open, unmerged PR after a failed create', async () => {
    let listed = 0;
    const fails = (after: unknown[]) => github(
      on('GET', /\/pulls\?state=all/, () => json(200, listed++ === 0 ? [] : after)),
      on('POST', '/repos/acme/app/pulls', () => json(422, { message: 'Validation Failed' })));
    listed = 0;
    await expect(fails([]).api.openOrUpdate(SLUG, { head: 'karmax/t', base: 'main', title: 'T', body: 'B' }))
      .rejects.toMatchObject({ status: 422 });
    listed = 0;
    await expect(fails([pr(4, { merged: true })]).api.openOrUpdate(SLUG, { head: 'karmax/t', base: 'main', title: 'T', body: 'B' }))
      .rejects.toMatchObject({ status: 422 });
    listed = 0;
    expect(await fails([pr(5)]).api.openOrUpdate(SLUG, { head: 'karmax/t', base: 'main', title: 'T', body: 'B' }))
      .toMatchObject({ created: false, pr: { number: 5 } });
  });

  it('posts a keyed comment once, finding an earlier receipt on any page', async () => {
    const full = Array.from({ length: 100 }, () => ({ body: 'noise' }));
    let receipt = '';
    const { api, calls } = github(
      on('GET', /\/comments\?per_page=100&page=1$/, () => json(200, full)),
      on('GET', /\/comments\?per_page=100&page=2$/, () => json(200, receipt ? [{ body: receipt }] : [])),
      on('POST', '/repos/acme/app/issues/9/comments', (body) => { receipt = body.body; return json(201, {}); }),
    );
    await api.commentOnce(SLUG, 9, 'Landed.', 'landing:9');
    expect(receipt).toMatch(/^Landed\.\n\n<!-- karmax-comment:[0-9a-f]{64} -->$/);
    await api.commentOnce(SLUG, 9, 'Landed.', 'landing:9');
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    await api.commentOnce(SLUG, 9, 'Other.', 'landing:other');
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(2);
  });

  it('gives up rather than post a comment it cannot prove is not already there', async () => {
    const full = Array.from({ length: 100 }, () => ({ body: 'noise' }));
    const { api, calls } = github(on('GET', /\/comments\?/, () => json(200, full)));
    await expect(api.commentOnce(SLUG, 9, 'x', 'k')).rejects.toThrow('cannot verify comment receipt');
    expect(calls).toHaveLength(100);
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it.each([
    [[{ message: 'API rate limit exceeded' }], 429],
    [[{ message: 'nope', type: 'FORBIDDEN' }], 403],
    [[{ message: 'nope', extensions: { type: 'UNAUTHORIZED' } }], 403],
    [[{ message: 'Could not resolve', type: 'NOT_FOUND' }], 404],
    [[{ message: 'Something went wrong' }], 502],
  ])('classifies GraphQL errors %j as HTTP %i', async (errors, status) => {
    const { api } = github(on('POST', '/graphql', () => json(200, { errors })));
    await expect(api.readiness(SLUG, 1)).rejects.toMatchObject({ status, message: expect.stringMatching(/^GitHub GraphQL: /) });
  });

  it('reports a missing pull request as 404', async () => {
    const { api } = github(on('POST', '/graphql', () => json(200, { data: { repository: { pullRequest: null } } })));
    await expect(api.readiness(SLUG, 404)).rejects.toMatchObject({ status: 404, message: 'GitHub pull request acme/app#404 was not found' });
  });

  it('reports the live target tip, not the PR\'s stale baseRefOid, so a moved target is a new observation', async () => {
    const readiness = (pullRequest: Record<string, unknown>) => github(on('POST', '/graphql', () => json(200, { data: {
      repository: { pullRequest: { id: 'PR_1', url: 'u', state: 'OPEN', isDraft: false, merged: false, headRefOid: 'h',
        mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', baseRefOid: 'opened-on', ...pullRequest } },
    } }))).api.readiness(SLUG, 1);
    expect((await readiness({ baseRef: { target: { oid: 'moved-to' } } })).baseSha).toBe('moved-to');
    expect((await readiness({ baseRef: null })).baseSha).toBe('opened-on');
  });

  it('derives the check state from the newest run of each check when duplicates were collapsed', async () => {
    const run = (conclusion: string, suiteCreatedAt: string, extra: Record<string, unknown> = {}) => ({ __typename: 'CheckRun',
      name: 'test', status: 'COMPLETED', conclusion, checkSuite: { app: { id: 'actions' }, createdAt: suiteCreatedAt }, ...extra });
    const readiness = (nodes: unknown[]) => github(on('POST', '/graphql', () => json(200, { data: { repository: { pullRequest: {
      id: 'PR_1', url: 'u', state: 'OPEN', isDraft: false, merged: false, headRefOid: 'h', mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN', statusCheckRollup: { state: 'FAILURE', contexts: { nodes, pageInfo: { hasNextPage: false } } },
    } } } }))).api.readiness(SLUG, 1);
    const cancelled = run('CANCELLED', '2026-09-01T00:00:00Z');
    const superseding = run('SUCCESS', '2026-09-01T00:05:00Z');
    expect((await readiness([cancelled, superseding])).checks).toBe('SUCCESS');
    expect((await readiness([cancelled, superseding, { __typename: 'StatusContext', context: 'ci', state: 'PENDING' }])).checks)
      .toBe('PENDING');
    expect((await readiness([cancelled, run('', '2026-09-01T00:05:00Z', { status: 'IN_PROGRESS' })])).checks).toBe('PENDING');
    const failed = await readiness([cancelled, superseding,
      { __typename: 'StatusContext', context: 'deploy', state: 'ERROR', targetUrl: 'https://ci/1', description: 'x'.repeat(2000) }]);
    expect(failed.checks).toBe('FAILURE');
    expect(failed.failedChecks).toEqual([{ name: 'deploy', state: 'ERROR', url: 'https://ci/1', detail: 'x'.repeat(1200) }]);
    // An older run arriving last never displaces the newer one.
    expect((await readiness([superseding, cancelled])).checks).toBe('SUCCESS');
  });

  it('reads failed checks for a ref from whichever of the Checks and Status APIs answer', async () => {
    const statuses = on('GET', /\/commits\/abc\/status/, () => json(200, { statuses: [
      { context: 'legacy', state: 'failure', target_url: 'https://ci/2', description: 'broke' },
      { context: 'fine', state: 'success' }] }));
    const runs = on('GET', /\/commits\/abc\/check-runs/, () => json(200, { check_runs: [
      { id: 11, name: 'lint', conclusion: 'failure', details_url: 'https://gh/run/11' }, { id: 12, name: 'ok', conclusion: 'success' }] }));
    const details = on('GET', '/repos/acme/app/check-runs/11', () => json(200, { output: { title: 'Lint', summary: ' 2 errors ', text: '' } }));
    const annotations = on('GET', /\/check-runs\/11\/annotations/, () => json(200, [
      { path: 'src/a.ts', start_line: 3, annotation_level: 'failure', message: 'unused variable' }]));

    const both = await github(statuses, runs, details, annotations).api.failedChecksForRef(SLUG, 'abc');
    expect(both.map((check) => [check.name, check.state])).toEqual([['lint', 'FAILURE'], ['legacy', 'FAILURE']]);
    expect(both[0]!.detail).toContain('2 errors');
    expect(both[0]!.detail).toContain('src/a.ts');
    expect(both[1]).toMatchObject({ url: 'https://ci/2', detail: 'broke' });

    // The Checks API is forbidden to this installation and the run details are unreadable.
    expect((await github(statuses).api.failedChecksForRef(SLUG, 'abc')).map((check) => check.name)).toEqual(['legacy']);
    const unreadable = await github(runs).api.failedChecksForRef(SLUG, 'abc');
    expect(unreadable).toEqual([{ name: 'lint', state: 'FAILURE', url: 'https://gh/run/11' }]);
    expect(await github().api.failedChecksForRef(SLUG, 'abc')).toEqual([]);
  });

  it('waits briefly for GitHub to move the head after a branch update', async () => {
    let reads = 0;
    const moving = github(on('PUT', '/repos/acme/app/pulls/3/update-branch', () => json(202, { message: 'Updating pull request branch.' })),
      on('GET', '/repos/acme/app/pulls/3', () => json(200, pr(3, { head: { ref: 'b', sha: ++reads < 3 ? 'old' : 'new' } }))));
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const updating = moving.api.updateBranch(SLUG, 3, 'old');
    await vi.runAllTimersAsync();
    expect(await updating).toEqual({ requested: true, headSha: 'new', message: 'Updating pull request branch.' });
    expect(moving.calls.at(0)).toMatchObject({ body: { expected_head_sha: 'old' } });

    const stuck = github(on('PUT', /update-branch/, () => json(202, {})),
      on('GET', '/repos/acme/app/pulls/3', () => json(200, pr(3, { head: { ref: 'b', sha: 'old' } }))));
    const waiting = stuck.api.updateBranch(SLUG, 3, 'old');
    await vi.runAllTimersAsync();
    expect(await waiting).toEqual({ requested: true, message: 'GitHub accepted the pull-request branch update' });
    expect(stuck.calls.filter((call) => call.method === 'GET')).toHaveLength(20);

    const conflict = github(on('PUT', /update-branch/, () => json(422, { message: 'merge conflict between base and head' })));
    expect(await conflict.api.updateBranch(SLUG, 3, 'old')).toEqual({ requested: false, message: 'merge conflict between base and head' });
  });

  it('reports GraphQL merge-queue and auto-merge refusals as messages, not exceptions', async () => {
    const refusing = github(on('POST', '/graphql', () => json(200, { errors: [{ message: 'Pull request is not in a queue' }] })));
    expect(await refusing.api.enqueue('PR_1', 'sha')).toEqual({ merged: false, queued: false, message: 'Pull request is not in a queue' });
    expect(refusing.calls[0]!.body.variables).toEqual({ input: { pullRequestId: 'PR_1', expectedHeadOid: 'sha' } });
    expect(await refusing.api.dequeue('PR_1')).toEqual({ withdrawn: false, message: 'Pull request is not in a queue' });
    expect(await refusing.api.disableAutoMerge('PR_1')).toEqual({ withdrawn: false, message: 'Pull request is not in a queue' });

    const accepting = github(on('POST', '/graphql', () => json(200, { data: { enqueuePullRequest: { mergeQueueEntry: { id: 'Q' } } } })));
    expect(await accepting.api.enqueue('PR_1')).toEqual({ merged: false, queued: true, message: 'Pull request queued for merge' });
    expect(await accepting.api.dequeue('PR_1')).toEqual({ withdrawn: true, message: 'Pull request removed from the merge queue' });
    expect(await accepting.api.disableAutoMerge('PR_1')).toEqual({ withdrawn: true, message: 'Pull request auto-merge disabled' });
    const silent = github(on('POST', '/graphql', () => json(200, { data: {} })));
    expect((await silent.api.enqueue('PR_1')).message).toBe('GitHub did not queue the pull request');
  });

  it('turns merge and ref refusals into results and every other failure into a classified error', async () => {
    const { api } = github(
      on('PUT', '/repos/acme/app/pulls/1/merge', () => json(405, { message: 'Base branch was modified' })),
      on('PUT', '/repos/acme/app/pulls/2/merge', () => json(200, { merged: true, sha: 'm' })),
      on('PATCH', '/repos/acme/app/git/refs/heads/release/1.x', () => json(422, { message: 'Update is not a fast forward' })),
      on('POST', '/repos/acme/app/pulls/1/reviews', () => json(204, undefined)),
      on('GET', '/repos/acme/app/pulls/7', () => json(500, { message: 'x'.repeat(1000) })),
    );
    expect(await api.merge(SLUG, 1, 'sha')).toEqual({ merged: false, message: 'Base branch was modified' });
    expect(await api.merge(SLUG, 2, 'sha', 'squash')).toEqual({ merged: true, sha: 'm', message: 'Pull request merged' });
    expect(await api.fastForwardTarget(SLUG, 'release/1.x', 'sha'))
      .toEqual({ updated: false, message: 'Update is not a fast forward' });
    await expect(api.approve(SLUG, 1, 'sha', 'LGTM')).resolves.toBeUndefined();
    const failure = await api.get(SLUG, 7).catch((error) => error);
    expect(failure).toBeInstanceOf(GithubApiError);
    expect(failure.status).toBe(500);
    expect(failure.message.length).toBeLessThan(350);
  });
});

describe('GitHub webhook correlation', () => {
  const repository = { id: 1, full_name: 'acme/app' };

  it('coalesces only head-bound synchronize and completed-check deliveries', () => {
    const synchronize = { taskId: 't', type: 'github.pr.synchronize', payload: { repo: 'Acme/App', number: 4, headSha: 'ABC' } };
    expect(githubPrWebhookObservationKey(synchronize)).toBe('t:acme/app#4:abc:synchronize');
    const check = { taskId: 't', type: 'github.check.completed', payload: { repo: 'acme/app', number: 4, headSha: 'abc',
      checkId: 9, name: 'Test', url: 'u', conclusion: 'FAILURE' } };
    expect(githubPrWebhookObservationKey(check)).toBe('t:acme/app#4:abc:check-run:9:test:u:failure');
    expect(githubPrWebhookObservationKey({ ...check, payload: { ...check.payload, conclusion: 'success' } }))
      .not.toBe(githubPrWebhookObservationKey(check));
    expect(githubPrWebhookObservationKey({ taskId: 't', type: 'github.pr.merged', payload: synchronize.payload })).toBeUndefined();
    expect(githubPrWebhookObservationKey({ ...synchronize, payload: { repo: 'acme/app', number: 4 } })).toBeUndefined();
  });

  it('ignores check runs that have not completed and reviews without a state', () => {
    const checkRun = (action: string) => ({ action, repository, check_run: { id: 5, name: 'ci', status: 'in_progress',
      check_suite: { head_branch: 'karmax/t', head_sha: 's' }, pull_requests: [{ number: 2, head: { ref: 'karmax/t', repo: { id: 1 } } }] } });
    expect(pullRequestWebhookEvent('check_run', checkRun('created'))).toBeUndefined();
    expect(pullRequestWebhookEvent('check_run', checkRun('completed'))).toMatchObject({ taskId: 't', type: 'github.check.completed',
      payload: { checkId: 5, number: 2, headSha: 's', repo: 'acme/app' } });
    expect(pullRequestWebhookEvent('check_run', { ...checkRun('completed'), check_run: { ...checkRun('completed').check_run,
      pull_requests: [] } })).toBeUndefined();
    const pull_request = { number: 2, head: { ref: 'karmax/t', repo: { id: 1 }, sha: 's' }, base: { ref: 'main' }, state: 'open' };
    expect(pullRequestWebhookEvent('pull_request_review', { repository, pull_request,
      review: { author_association: 'MEMBER', state: '' } })).toBeUndefined();
    expect(pullRequestWebhookEvent('pull_request', { repository, pull_request })).toBeUndefined();
    expect(pullRequestWebhookEvent('pull_request', { repository: {}, pull_request, action: 'opened' })).toBeUndefined();
    expect(pullRequestWebhookEvent('push', { repository, pull_request, action: 'opened' })).toBeUndefined();
  });
});
