import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { WorktreeProvider } from '../src/world/worktree.js';
import { git, gitOrThrow, ensureIdentity } from '../src/world/git.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { GithubPrApi, githubSlug, taskIdOfBranch, pullRequestWebhookEvent, reconcilePullRequestView } from '../src/integrations/github-pr.js';
import { GithubActionsApiError } from '../src/integrations/github-actions.js';
import type { TaskPullRequest } from '../src/domain/types.js';
import { ensureProjectWikiRepository } from '../src/wiki/repository.js';

/** The GitHub pull-request integration (SPEC §5.2, wiki plans/PLAN-git-config §5):
 *  the REST client, the PR stage activity, merge/cancel reconciliation, and the
 *  webhook → karmax event feed. */

let tmp: string;
let broker: CredentialBroker;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-ghpr-'));
  broker = new CredentialBroker(new Vault(path.join(tmp, 'vault')));
  process.env.GH_TOKEN = 'ghp_test';
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.GH_TOKEN;
});

const SLUG = 'acme/widgets';
const REMOTE = `git@github.com:${SLUG}.git`;

/** An in-memory GitHub, exercising the exact REST surface karmax uses. */
function fakeGithub() {
  const prs: any[] = [];
  const comments: { number: number; body: string }[] = [];
  const calls: string[] = [];
  const tokens: string[] = [];
  let next = 1;
  const fetcher = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(String(url));
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : {};
    calls.push(`${method} ${u.pathname}${u.search}`);
    tokens.push(new Headers(init.headers).get('authorization') ?? '');
    const json = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (u.pathname.includes('/compare/')) return json(200, { ahead_by: 0 });
    const list = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/pulls$/);
    if (list && method === 'GET') {
      const head = u.searchParams.get('head');
      const branch = head?.split(':')[1];
      return json(200, prs.filter((pr) => pr.head.ref === branch && pr.repo === list[1]).reverse());
    }
    if (list && method === 'POST') {
      if (prs.some((pr) => pr.repo === list[1] && pr.head.ref === body.head && pr.state === 'open'))
        return json(422, { message: 'A pull request already exists' });
      const pr = { repo: list[1], number: next, html_url: `https://github.com/${list[1]}/pull/${next}`,
        state: 'open', merged_at: null, title: body.title, body: body.body,
        head: { ref: body.head }, base: { ref: body.base } };
      next++;
      prs.push(pr);
      return json(201, pr);
    }
    const one = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/);
    if (one) {
      const pr = prs.find((candidate) => candidate.number === Number(one[2]) && candidate.repo === one[1]);
      if (!pr) return json(404, { message: 'Not Found' });
      // Real GitHub rule (task 387): a closed PR's base cannot change.
      if (method === 'PATCH' && pr.state === 'closed' && body.state !== 'open' && 'base' in body)
        return json(422, { message: 'Validation Failed', errors: [{ message: 'Cannot change the base branch of a closed pull request.' }] });
      if (method === 'PATCH' && pr.state === 'closed' && body.state === 'open' && pr.unreopenable)
        return json(422, { message: 'Validation Failed', errors: [{ message: 'state cannot be changed. The branch was force-pushed or recreated.' }] });
      if (method === 'PATCH') Object.assign(pr, body);
      return json(200, pr);
    }
    const comment = u.pathname.match(/^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/);
    if (comment && method === 'GET') {
      const page = Number(u.searchParams.get('page') ?? 1);
      return json(200, comments.filter(row => row.number === Number(comment[1])).slice((page - 1) * 100, page * 100));
    }
    if (comment && method === 'POST') {
      comments.push({ number: Number(comment[1]), body: body.body });
      return json(201, { id: comments.length });
    }
    return json(404, { message: `unrouted ${method} ${u.pathname}` });
  }) as unknown as typeof fetch;
  return { fetcher, prs, comments, calls, tokens, options: { apiBase: 'https://api.github.test', fetch: fetcher } };
}

/** A repo whose origin *reads* as GitHub but pushes to a local bare repo, so
 *  the whole activity (slug detection + real push + API) runs unmodified. */
async function repoWithGithubOrigin(name: string, slug = SLUG): Promise<string> {
  const repo = path.join(tmp, name);
  fs.mkdirSync(repo, { recursive: true });
  await gitOrThrow(repo, ['init', '-q', '-b', 'main']);
  await ensureIdentity(repo);
  fs.writeFileSync(path.join(repo, 'index.js'), 'console.log(1)\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-q', '-m', 'init']);
  const origin = path.join(tmp, `${name}-origin.git`);
  await gitOrThrow(tmp, ['init', '-q', '--bare', '-b', 'main', origin]);
  const remote = `git@github.com:${slug}.git`;
  await git(repo, ['remote', 'add', 'origin', remote]);
  await git(repo, ['config', `url.${origin}.insteadOf`, remote]);
  await git(repo, ['push', '-q', 'origin', 'main']);
  return repo;
}

async function coreFor(github: { options: { apiBase?: string; fetch?: typeof fetch } },
  githubApp?: Record<string, unknown>, dbPath = ':memory:') {
  const { Store } = await import('../src/store/db.js');
  const { WorldRegistry } = await import('../src/world/registry.js');
  const { ProfileResolver } = await import('../src/agent/profiles.js');
  const { makeCoreActivities } = await import('../src/activities/core.js');
  const store = (await Store.create(dbPath));
  const worlds = new WorldRegistry();
  worlds.register(new WorktreeProvider(path.join(tmp, 'worlds')));
  const core = makeCoreActivities({ store, worlds, adapters: new Map(),
    profiles: new ProfileResolver(store, 'mock'), broker, githubPr: github.options,
    contentDir: path.join(tmp, 'content'),
    ...(githubApp ? { githubApp: githubApp as any } : {}) });
  return Object.assign(core, { store });
}

async function remoteCoreFor(github: { options: { apiBase?: string; fetch?: typeof fetch } },
  githubApp: Record<string, unknown>, contentDir: string) {
  const { Store } = await import('../src/store/db.js');
  const { WorldRegistry } = await import('../src/world/registry.js');
  const { ProfileResolver } = await import('../src/agent/profiles.js');
  const { makeCoreActivities } = await import('../src/activities/core.js');
  const store = (await Store.create(':memory:'));
  const worlds = new WorldRegistry();
  const backing = new WorktreeProvider(path.join(tmp, 'remote-worlds'));
  const active = new Map<string, any>();
  worlds.register({
    kind: 'fake-remote', capabilities: { remote: true },
    async create(spec: any) {
      const sources = spec.copySources as string[];
      const world = await backing.create({ ...spec, repo: undefined, repos: sources, copySources: undefined });
      world.handle.kind = 'fake-remote';
      const remotes: string[] = spec.repos ?? [spec.repo];
      for (const [index, repo] of world.handle.repos!.entries()) {
        repo.repo = remotes[index]!;
        repo.localPath = sources[index]!;
      }
      world.handle.repo = remotes[0]!;
      // The backing worktrees are released from their host checkouts. Their
      // SSH-shaped remote names would otherwise be locked as paths relative to
      // the test's working directory, leaving `git@github.com:…/` behind.
      const destroy = world.destroy.bind(world);
      world.destroy = async () => {
        for (const [index, repo] of world.handle.repos!.entries()) repo.repo = sources[index]!;
        world.handle.repo = sources[0]!;
        await destroy();
      };
      active.set(spec.taskId, world);
      return world;
    },
    async open(handle: any) { return active.get(handle.id)!; },
    async destroy(handle: any) { await active.get(handle.id)?.destroy(); active.delete(handle.id); },
  } as any);
  const core = makeCoreActivities({ store, worlds, adapters: new Map(),
    profiles: new ProfileResolver(store, 'mock'), broker, githubPr: github.options,
    githubApp: githubApp as any, contentDir });
  return Object.assign(core, { store });
}

describe('GitHub PR client', () => {
  it('reads a slug from every remote shape and correlates karmax task branches', () => {
    expect(githubSlug('git@github.com:acme/widgets.git')).toBe('acme/widgets');
    expect(githubSlug('https://github.com/acme/widgets')).toBe('acme/widgets');
    expect(githubSlug('ssh://git@github.com/acme/widgets.git')).toBe('acme/widgets');
    expect(githubSlug('git@gitlab.com:acme/widgets.git')).toBeUndefined();
    expect(githubSlug('/home/me/widgets')).toBeUndefined();
    expect(taskIdOfBranch('tavya/task_abc')).toBe('task_abc');
    expect(taskIdOfBranch('feature/x')).toBeUndefined();
  });

  it('refuses malformed repository slugs before making requests', async () => {
    const gh = fakeGithub();
    const api = new GithubPrApi('t', gh.options);
    for (const slug of ['acme/app?x=1', 'acme/app#fragment', '../app', 'acme/..', 'acme/app/extra', 'acme/a%2Fb'])
      await expect(api.get(slug, 7)).rejects.toThrow(/repository slug/);
    expect(gh.calls).toEqual([]);
  });

  it('opens once, then updates the same PR instead of opening a second one', async () => {
    const gh = fakeGithub();
    const api = new GithubPrApi('t', gh.options);
    const first = await api.openOrUpdate(SLUG, { head: 'tavya/t1', base: 'main', title: 'One', body: 'first' });
    expect(first.created).toBe(true);
    const second = await api.openOrUpdate(SLUG, { head: 'tavya/t1', base: 'main', title: 'Two', body: 'second' });
    expect(second.created).toBe(false);
    expect(second.pr.number).toBe(first.pr.number);
    expect(gh.prs).toHaveLength(1);
    expect(gh.prs[0].title).toBe('Two');
    expect(gh.prs[0].body).toBe('second');
  });

  it('binds a merge to the reviewed head and can enter a GitHub merge queue', async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const body = init.body ? JSON.parse(String(init.body)) : {};
      calls.push({ path: url.pathname, body });
      if (url.pathname.endsWith('/pulls/7/reviews')) return Response.json({ id: 9 });
      if (url.pathname.endsWith('/pulls/7/merge')) return Response.json({ merged: true, sha: 'merge-sha', message: 'merged' });
      if (url.pathname.endsWith('/git/refs/heads/main'))
        return Response.json({ ref: 'refs/heads/main', object: { sha: body.sha } });
      if (url.pathname === '/graphql') return Response.json({ data: { enqueuePullRequest: { mergeQueueEntry: { id: 'queue-1' } } } });
      return Response.json({ message: 'not found' }, { status: 404 });
    }) as typeof fetch;
    const api = new GithubPrApi('user-token', { apiBase: 'https://api.github.test', fetch: fetcher });
    await api.approve(SLUG, 7, 'reviewed-sha', 'approved in krmax');
    await expect(api.merge(SLUG, 7, 'reviewed-sha')).resolves.toEqual({ merged: true, sha: 'merge-sha', message: 'merged' });
    await expect(api.fastForwardTarget(SLUG, 'main', 'reviewed-sha')).resolves.toEqual({
      updated: true, message: 'Target advanced to the validated pull-request head',
    });
    await expect(api.enqueue('PR_node', 'reviewed-sha')).resolves.toMatchObject({ queued: true, merged: false });
    expect(calls[0]).toMatchObject({ path: `/repos/${SLUG}/pulls/7/reviews`,
      body: { commit_id: 'reviewed-sha', event: 'APPROVE' } });
    expect(calls[1]).toMatchObject({ path: `/repos/${SLUG}/pulls/7/merge`, body: { sha: 'reviewed-sha' } });
    expect(calls[2]).toMatchObject({ path: `/repos/${SLUG}/git/refs/heads/main`,
      body: { sha: 'reviewed-sha', force: false } });
    expect(calls[3]!.body).toMatchObject({ variables: { input: {
      pullRequestId: 'PR_node', expectedHeadOid: 'reviewed-sha',
    } } });
  });

  it('inspects review, checks, queue, and auto-merge readiness through GraphQL', async () => {
    let request: any;
    const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
      expect(new URL(String(input)).pathname).toBe('/graphql');
      request = JSON.parse(String(init.body));
      return Response.json({ data: { repository: { pullRequest: {
        id: 'PR_node', url: 'https://github.test/acme/widgets/pull/7', state: 'OPEN', isDraft: false,
        merged: false, headRefOid: 'abc123', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
        reviewDecision: 'APPROVED', statusCheckRollup: { state: 'SUCCESS' },
        mergeQueueEntry: { id: 'MQ_node' }, autoMergeRequest: { enabledAt: '2026-08-03T00:00:00Z', mergeMethod: 'SQUASH' },
        viewerCanEnableAutoMerge: true, viewerCanMergeAsAdmin: false,
      } } } });
    }) as typeof fetch;
    const api = new GithubPrApi('user-token', { apiBase: 'https://api.github.test', fetch: fetcher });

    await expect(api.readiness(SLUG, 7)).resolves.toEqual({
      nodeId: 'PR_node', url: 'https://github.test/acme/widgets/pull/7', state: 'open', draft: false,
      merged: false, headSha: 'abc123', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
      reviewDecision: 'APPROVED', checks: 'SUCCESS', mergeQueueEntryId: 'MQ_node',
      autoMerge: { enabledAt: '2026-08-03T00:00:00Z', mergeMethod: 'squash' },
      viewerCanEnableAutoMerge: true, viewerCanMergeAsAdmin: false,
    });
    expect(request.variables).toEqual({ owner: 'acme', name: 'widgets', number: 7 });
    expect(request.query).toContain('mergeStateStatus');
    expect(request.query).toContain('statusCheckRollup');
    expect(request.query).toContain('contexts(first: 50)');
    expect(request.query).not.toContain('output {');
  });

  it('extracts actionable details from failed check runs and legacy statuses', async () => {
    const fetcher = (async (input: string | URL | Request) => {
      if (new URL(String(input)).pathname.endsWith('/check-runs/101/annotations')) return Response.json([{
        path: 'src/math.test.ts', start_line: 42, annotation_level: 'failure',
        title: 'AssertionError', message: 'expected 2, received 3',
      }]);
      if (new URL(String(input)).pathname.endsWith('/check-runs/101')) return Response.json({ output: {
        title: 'Vitest failed', summary: 'One test failed', text: 'Complete captured check output',
      } });
      return Response.json({ data: { repository: { pullRequest: {
      id: 'PR_failed', url: 'https://github.test/acme/widgets/pull/9', state: 'OPEN', isDraft: false,
      merged: false, headRefOid: 'failed-head', mergeable: 'MERGEABLE', mergeStateStatus: 'UNSTABLE',
      statusCheckRollup: { state: 'FAILURE', contexts: { nodes: [
        { __typename: 'CheckRun', databaseId: 101, name: 'unit tests', status: 'COMPLETED', conclusion: 'FAILURE',
          detailsUrl: 'https://github.test/checks/1' },
        { __typename: 'StatusContext', context: 'lint', state: 'ERROR',
          targetUrl: 'https://ci.test/lint', description: 'runner crashed' },
        { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
      ] } },
      viewerCanEnableAutoMerge: false, viewerCanMergeAsAdmin: false,
    } } } });
    }) as typeof fetch;
    const api = new GithubPrApi('user-token', { apiBase: 'https://api.github.test', fetch: fetcher });

    await expect(api.readiness(SLUG, 9)).resolves.toMatchObject({
      checks: 'FAILURE',
      failedChecks: [
        { name: 'unit tests', state: 'FAILURE', url: 'https://github.test/checks/1', detail: expect.stringMatching(/Complete captured check output.*src\/math\.test\.ts:42.*AssertionError/is) },
        { name: 'lint', state: 'ERROR', url: 'https://ci.test/lint', detail: 'runner crashed' },
      ],
    });
  });

  it('treats a newer successful same-context check run as authoritative over a cancelled duplicate', async () => {
    let hasNextPage = false;
    const fetcher = (async () => Response.json({ data: { repository: { pullRequest: {
      id: 'PR_superseded', url: 'https://github.test/acme/widgets/pull/10', state: 'OPEN', isDraft: false,
      merged: false, headRefOid: 'same-head', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
      statusCheckRollup: { state: 'FAILURE', contexts: { pageInfo: { hasNextPage }, nodes: [
        { __typename: 'CheckRun', databaseId: 101, name: 'typecheck + tests', status: 'COMPLETED',
          conclusion: 'CANCELLED', startedAt: '2026-08-19T23:56:59Z', completedAt: '2026-08-19T23:57:00Z',
          detailsUrl: 'https://github.com/acme/widgets/actions/runs/32315364360/job/96266354140',
          checkSuite: { databaseId: 87605644005, createdAt: '2026-08-19T23:56:58Z',
            app: { id: 'MDM6QXBwNDMxNjQ2Nw==' } } },
        { __typename: 'CheckRun', databaseId: 102, name: 'typecheck + tests', status: 'COMPLETED',
          conclusion: 'SUCCESS', startedAt: '2026-08-19T23:57:03Z', completedAt: '2026-08-20T00:11:45Z',
          detailsUrl: 'https://github.com/acme/widgets/actions/runs/32315365515/job/96266359059',
          checkSuite: { databaseId: 87605646835, createdAt: '2026-08-19T23:57:00Z',
            app: { id: 'MDM6QXBwNDMxNjQ2Nw==' } } },
        { __typename: 'CheckRun', databaseId: 103, name: 'deploy artifacts', status: 'COMPLETED',
          conclusion: 'CANCELLED', startedAt: '2026-08-19T23:56:59Z', completedAt: '2026-08-19T23:57:00Z',
          detailsUrl: 'https://github.com/acme/widgets/actions/runs/32315364360/job/96266354015',
          checkSuite: { databaseId: 87605644005, createdAt: '2026-08-19T23:56:58Z',
            app: { id: 'MDM6QXBwNDMxNjQ2Nw==' } } },
        { __typename: 'CheckRun', databaseId: 104, name: 'deploy artifacts', status: 'COMPLETED',
          conclusion: 'SUCCESS', startedAt: '2026-08-19T23:57:03Z', completedAt: '2026-08-20T00:00:26Z',
          detailsUrl: 'https://github.com/acme/widgets/actions/runs/32315365515/job/96266359214',
          checkSuite: { databaseId: 87605646835, createdAt: '2026-08-19T23:57:00Z',
            app: { id: 'MDM6QXBwNDMxNjQ2Nw==' } } },
      ] } },
      viewerCanEnableAutoMerge: false, viewerCanMergeAsAdmin: false,
    } } } })) as typeof fetch;
    const api = new GithubPrApi('app-token', { apiBase: 'https://api.github.test', fetch: fetcher });

    const current = await api.readiness(SLUG, 10);
    expect(current).toMatchObject({
      checks: 'SUCCESS',
      mergeStateStatus: 'CLEAN',
    });
    expect(current.failedChecks).toBeUndefined();

    // Never turn an aggregate failure green when another failing context may
    // exist beyond the bounded GraphQL page.
    hasNextPage = true;
    await expect(api.readiness(SLUG, 10)).resolves.toMatchObject({ checks: 'FAILURE' });
  });

  it('reports native queue removal and reads failures from the speculative merge-group commit', async () => {
    const fetcher = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/commits/merge-group-sha/check-runs')) return Response.json({ check_runs: [{
        id: 202, name: 'merge train', status: 'completed', conclusion: 'failure',
        details_url: 'https://github.test/checks/202',
      }] });
      if (path.endsWith('/commits/merge-group-sha/status')) return Response.json({ statuses: [{
        context: 'external CI', state: 'error', target_url: 'https://ci.test/group', description: 'runner lost',
      }] });
      if (path.endsWith('/check-runs/202/annotations')) return Response.json([{
        path: 'src/queue.test.ts', start_line: 19, title: 'AssertionError', message: 'combined code failed',
      }]);
      if (path.endsWith('/check-runs/202')) return Response.json({ output: {
        title: 'Merge-group CI failed', summary: 'The speculative prefix is incompatible', text: 'full queue output',
      } });
      return Response.json({ data: { repository: { pullRequest: {
        id: 'PR_queue', url: 'https://github.test/acme/widgets/pull/12', state: 'OPEN', isDraft: false,
        merged: false, headRefOid: 'green-pr-head', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
        statusCheckRollup: { state: 'SUCCESS', contexts: { nodes: [] } },
        timelineItems: { nodes: [{ createdAt: '2026-08-06T12:00:00Z',
          reason: 'Required status check failed', beforeCommit: { oid: 'merge-group-sha' } }] },
        viewerCanEnableAutoMerge: false, viewerCanMergeAsAdmin: false,
      } } } });
    }) as typeof fetch;
    const api = new GithubPrApi('app-token', { apiBase: 'https://api.github.test', fetch: fetcher });

    await expect(api.readiness(SLUG, 12)).resolves.toMatchObject({
      checks: 'SUCCESS',
      removedFromMergeQueue: {
        createdAt: '2026-08-06T12:00:00Z', reason: 'Required status check failed',
        beforeCommitSha: 'merge-group-sha',
      },
    });
    await expect(api.failedChecksForRef(SLUG, 'merge-group-sha')).resolves.toEqual([
      expect.objectContaining({ name: 'merge train', state: 'FAILURE',
        detail: expect.stringMatching(/full queue output.*src\/queue\.test\.ts:19.*combined code failed/is) }),
      { name: 'external CI', state: 'ERROR', url: 'https://ci.test/group', detail: 'runner lost' },
    ]);
  });

  it('falls back to aggregate check state when the App cannot enumerate CheckRuns', async () => {
    const requests: any[] = [];
    const fetcher = (async (_input: string | URL | Request, init: RequestInit = {}) => {
      const request = JSON.parse(String(init.body));
      requests.push(request);
      if (request.query.includes('contexts(first: 50)')) {
        return Response.json({ errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }] });
      }
      return Response.json({ data: { repository: { pullRequest: {
        id: 'PR_limited', url: 'https://github.test/acme/widgets/pull/10', state: 'OPEN', isDraft: false,
        merged: false, headRefOid: 'limited-head', mergeable: 'MERGEABLE', mergeStateStatus: 'UNSTABLE',
        statusCheckRollup: { state: 'FAILURE' }, viewerCanEnableAutoMerge: false, viewerCanMergeAsAdmin: false,
      } } } });
    }) as typeof fetch;
    const api = new GithubPrApi('limited-app-user-token', { apiBase: 'https://api.github.test', fetch: fetcher });

    await expect(api.readiness(SLUG, 10)).resolves.toMatchObject({
      headSha: 'limited-head', checks: 'FAILURE',
    });
    expect(requests).toHaveLength(2);
    expect(requests[0].query).toContain('contexts(first: 50)');
    expect(requests[1].query).not.toContain('contexts(first: 50)');
  });

  it('fails closed on policy state when an older App cannot read any CI rollup', async () => {
    const requests: any[] = [];
    const fetcher = (async (_input: string | URL | Request, init: RequestInit = {}) => {
      const request = JSON.parse(String(init.body));
      requests.push(request);
      if (request.query.includes('statusCheckRollup')) {
        return Response.json({ errors: [{ type: 'FORBIDDEN', path: ['repository', 'pullRequest', 'statusCheckRollup'],
          message: 'Resource not accessible by integration' }] });
      }
      return Response.json({ data: { repository: { pullRequest: {
        id: 'PR_legacy_app', url: 'https://github.test/acme/widgets/pull/11', state: 'OPEN', isDraft: false,
        merged: false, headRefOid: 'legacy-head', mergeable: 'MERGEABLE', mergeStateStatus: 'UNSTABLE',
        viewerCanEnableAutoMerge: false, viewerCanMergeAsAdmin: false,
      } } } });
    }) as typeof fetch;
    const api = new GithubPrApi('legacy-app-token', { apiBase: 'https://api.github.test', fetch: fetcher });

    await expect(api.readiness(SLUG, 11)).resolves.toMatchObject({
      headSha: 'legacy-head', mergeStateStatus: 'UNSTABLE', checksUnavailable: true,
    });
    expect(requests).toHaveLength(3);
    expect(requests[0].query).toContain('contexts(first: 50)');
    expect(requests[1].query).toContain('statusCheckRollup');
    expect(requests[1].query).not.toContain('contexts(first: 50)');
    expect(requests[2].query).not.toContain('statusCheckRollup');
  });

  it('enables auto-merge only for the expected head SHA', async () => {
    let request: any;
    const fetcher = (async (_input: string | URL | Request, init: RequestInit = {}) => {
      request = JSON.parse(String(init.body));
      return Response.json({ data: { enablePullRequestAutoMerge: { pullRequest: {
        id: 'PR_node', autoMergeRequest: { enabledAt: '2026-08-03T00:00:00Z', mergeMethod: 'REBASE' },
      } } } });
    }) as typeof fetch;
    const api = new GithubPrApi('user-token', { apiBase: 'https://api.github.test', fetch: fetcher });

    await expect(api.enableAutoMerge('PR_node', 'abc123', 'rebase')).resolves.toEqual({
      enabled: true, pullRequestId: 'PR_node', enabledAt: '2026-08-03T00:00:00Z',
      mergeMethod: 'rebase', message: 'Pull request auto-merge enabled',
    });
    expect(request.variables).toEqual({ input: {
      pullRequestId: 'PR_node', expectedHeadOid: 'abc123', mergeMethod: 'REBASE',
    } });
  });

  it('mechanically updates a behind branch with an expected-head guard', async () => {
    let head = 'old-head';
    let body: any;
    const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/update-branch')) {
        body = JSON.parse(String(init.body));
        head = 'updated-head';
        return Response.json({ message: 'Updating pull request branch.' }, { status: 202 });
      }
      return Response.json({ number: 7, html_url: 'https://github.test/acme/widgets/pull/7', state: 'open',
        merged: false, head: { ref: 'tavya/task_update', sha: head }, base: { ref: 'main' } });
    }) as typeof fetch;
    const api = new GithubPrApi('user-token', { apiBase: 'https://api.github.test', fetch: fetcher });

    await expect(api.updateBranch(SLUG, 7, 'old-head')).resolves.toEqual({
      requested: true, headSha: 'updated-head', message: 'Updating pull request branch.',
    });
    expect(body).toEqual({ expected_head_sha: 'old-head' });
  });

  it('refreshes a GitHub App user token once when GitHub rejects it', async () => {
    const forced: boolean[] = [];
    const fetcher = (async (_url: string, init: RequestInit = {}) => {
      const token = new Headers(init.headers).get('authorization');
      if (token === 'Bearer dead') return new Response('bad credentials', { status: 401 });
      return Response.json({ number: 7, html_url: 'https://github.test/acme/widgets/pull/7', state: 'open' });
    }) as typeof fetch;
    const api = new GithubPrApi(async (options) => {
      forced.push(Boolean(options?.forceRefresh));
      return options?.forceRefresh ? 'fresh' : 'dead';
    }, { apiBase: 'https://api.github.test', fetch: fetcher });

    await expect(api.get(SLUG, 7)).resolves.toMatchObject({ number: 7, state: 'open' });
    expect(forced).toEqual([false, true]);
  });

  it('reopens a PR that was closed without merging, but never reopens a merged one', async () => {
    const gh = fakeGithub();
    const api = new GithubPrApi('t', gh.options);
    const { pr } = await api.openOrUpdate(SLUG, { head: 'tavya/t2', base: 'main', title: 'T', body: 'b' });
    await api.update(SLUG, pr.number, { state: 'closed' });
    expect((await api.openOrUpdate(SLUG, { head: 'tavya/t2', base: 'main', title: 'T', body: 'b' })).pr.state).toBe('open');

    // Retargeted while closed: reopen first, then change the base (task 387).
    await api.update(SLUG, pr.number, { state: 'closed' });
    const retargeted = await api.openOrUpdate(SLUG, { head: 'tavya/t2', base: 'release', title: 'T', body: 'b' });
    expect(retargeted.pr).toMatchObject({ number: pr.number, state: 'open' });
    expect(gh.prs[0].base.ref ?? gh.prs[0].base).toBe('release');

    // A closed PR GitHub will not reopen is replaced by a fresh one.
    await api.update(SLUG, pr.number, { state: 'closed' });
    gh.prs[0].unreopenable = true;
    const replaced = await api.openOrUpdate(SLUG, { head: 'tavya/t2', base: 'main', title: 'T', body: 'b' });
    expect(replaced).toMatchObject({ created: true, pr: { state: 'open' } });
    expect(replaced.pr.number).not.toBe(pr.number);
    gh.prs.splice(1);
    gh.prs[0].unreopenable = false;

    gh.prs[0].state = 'closed';
    gh.prs[0].merged_at = '2026-01-01T00:00:00Z';
    const merged = await api.openOrUpdate(SLUG, { head: 'tavya/t2', base: 'main', title: 'T', body: 'b' });
    expect(merged.pr.state).toBe('closed');
    expect(merged.pr.merged).toBe(true);
  });

  it.each(['merged', 'closed'])('opens a fresh PR for new work after a %s PR', async (state) => {
    const gh = fakeGithub();
    const api = new GithubPrApi('t', gh.options);
    const input = { head: 'karmax/followup', base: 'main', title: 'Follow-up', body: 'New work' };
    const original = await api.openOrUpdate(SLUG, input);
    gh.prs[0].state = 'closed';
    if (state === 'merged') gh.prs[0].merged_at = '2026-01-01T00:00:00Z';
    const followup = new GithubPrApi('t', { ...gh.options, fetch: (async (url: any, init: any = {}) => {
      if (String(url).includes('/compare/')) return Response.json({ ahead_by: 2 });
      if (init.method === 'PATCH') return Response.json({ message: 'Head branch was force pushed' }, { status: 422 });
      return gh.fetcher(url, init);
    }) as typeof fetch });
    const result = await followup.openOrUpdate(SLUG, input);
    expect(result.created).toBe(true);
    expect(result.pr.number).not.toBe(original.pr.number);
    expect(result.pr).toMatchObject({ state: 'open', merged: false });
    expect((await api.openOrUpdate(SLUG, input)).pr.number).toBe(result.pr.number);
  });

  it('adopts the existing PR when GitHub rejects the create as a duplicate', async () => {
    const gh = fakeGithub();
    const api = new GithubPrApi('t', gh.options);
    await api.openOrUpdate(SLUG, { head: 'tavya/t3', base: 'main', title: 'T', body: 'b' });
    // A racing creator sees no PR from `findByHead`, so it POSTs and gets a 422.
    const raced = new GithubPrApi('t', { ...gh.options, fetch: (async (url: string, init: RequestInit = {}) => {
      if ((init.method ?? 'GET') === 'GET' && String(url).includes('/pulls?')) {
        const seen = new URL(String(url));
        if (!seen.searchParams.get('raced')) return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return gh.fetcher(url as any, init);
    }) as unknown as typeof fetch });
    const result = await raced.openOrUpdate(SLUG, { head: 'tavya/t3', base: 'main', title: 'T', body: 'b' })
      .catch((e) => e as Error);
    expect(result).toBeInstanceOf(Error); // both lookups blind → the 422 surfaces
    expect(gh.prs).toHaveLength(1);
  });
});

describe('GitHub-authoritative merge activity', () => {
  it('completes a no-change task without requiring a GitHub authorizer', async () => {
    const core = await coreFor(fakeGithub());
    await expect(core.mergeGithubPrs({ id: 'task_no_changes' } as any, []))
      .resolves.toEqual({ status: 'merged', prs: [] });
  });

  it('fast-forwards a clean enrolled local target after a provider merge', async () => {
    const repo = await repoWithGithubOrigin('mirror-after-merge');
    const writer = path.join(tmp, 'provider-writer');
    await gitOrThrow(tmp, ['clone', '-q', path.join(tmp, 'mirror-after-merge-origin.git'), writer]);
    await ensureIdentity(writer);
    fs.writeFileSync(path.join(writer, 'landed.txt'), 'landed by GitHub\n');
    await gitOrThrow(writer, ['add', '-A']);
    await gitOrThrow(writer, ['commit', '-q', '-m', 'provider merge']);
    await gitOrThrow(writer, ['push', '-q', 'origin', 'main']);
    const landedSha = (await gitOrThrow(writer, ['rev-parse', 'HEAD'])).trim();

    const fetcher = (async () => Response.json({
      number: 91, html_url: 'https://github.test/acme/widgets/pull/91', state: 'closed', merged: true,
      merged_at: '2026-08-04T00:00:00Z', merge_commit_sha: landedSha,
      head: { ref: 'tavya/task_mirror', sha: landedSha }, base: { ref: 'main' },
    })) as typeof fetch;
    const app = {
      activeUserAccountId: () => 'owner-account',
      repositoryPermission: async () => ({ slug: SLUG, permission: 'write', canMerge: true }),
      userAccessToken: async () => 'owner-token',
    };
    const core = await coreFor({ options: { apiBase: 'https://api.github.test', fetch: fetcher } }, app);
    (await core.store.claimPersonalOrganization('owner'));
    const project = (await core.store.createProject('Provider mirror'));
    const task = (await core.store.createTask({ projectId: project.id, title: 'Mirror me', workflow: 'software-dev',
      workflowVersion: '1.16.0', params: { prompt: 'x' }, createdBy: { kind: 'user', userId: 'owner' } }));
    const handle = {
      id: task.id, kind: 'worktree', root: repo, workdir: repo, branch: 'tavya/task_mirror', base: 'main',
      repo, meta: { projectId: project.id }, repos: [{ name: 'widgets', repo, root: repo,
        branch: 'tavya/task_mirror', base: 'main', target: 'main', localPath: repo, sourceAuthority: 'origin' }],
    } as any;
    const ref: TaskPullRequest = { repo: 'widgets', slug: SLUG, number: 91,
      url: 'https://github.test/acme/widgets/pull/91', state: 'open', headSha: landedSha };

    await expect(core.mergeGithubPrs(handle, [{ ...ref, headSha: 'new-unmerged-head' }])).resolves.toMatchObject({
      status: 'needs-revision',
    });
    await expect(core.mergeGithubPrs(handle, [ref])).resolves.toMatchObject({
      status: 'merged', sha: landedSha,
    });
    expect((await gitOrThrow(repo, ['rev-parse', 'main'])).trim()).toBe(landedSha);
    expect(fs.readFileSync(path.join(repo, 'landed.txt'), 'utf8')).toBe('landed by GitHub\n');
    expect((await core.store.eventsSince(task.id, 0)).map((event: any) => event.type)).toEqual(
      expect.arrayContaining(['checkout.synced', 'merge.result']),
    );
  });

  it('reconciles concurrent canonical and task edits after a project-wiki PR merge', async () => {
    const repo = await repoWithGithubOrigin('wiki-divergence-after-merge');
    const writer = path.join(tmp, 'wiki-provider-writer');
    await gitOrThrow(tmp, ['clone', '-q', path.join(tmp, 'wiki-divergence-after-merge-origin.git'), writer]);
    await ensureIdentity(writer);

    fs.writeFileSync(path.join(repo, 'canonical-memory.md'), 'saved through the live wiki\n');
    await gitOrThrow(repo, ['add', '-A']);
    await gitOrThrow(repo, ['commit', '-q', '-m', 'wiki: update canonical-memory']);

    fs.writeFileSync(path.join(writer, 'task-memory.md'), 'landed through Review\n');
    await gitOrThrow(writer, ['add', '-A']);
    await gitOrThrow(writer, ['commit', '-q', '-m', 'wiki: update task-memory']);
    await gitOrThrow(writer, ['push', '-q', 'origin', 'main']);
    const landedSha = (await gitOrThrow(writer, ['rev-parse', 'HEAD'])).trim();

    const fetcher = (async () => Response.json({
      number: 93, html_url: 'https://github.test/acme/widgets/pull/93', state: 'closed', merged: true,
      merged_at: '2026-08-09T00:00:00Z', merge_commit_sha: landedSha,
      head: { ref: 'tavya/task_wiki', sha: landedSha }, base: { ref: 'main' },
    })) as typeof fetch;
    const app = {
      activeUserAccountId: () => 'owner-account',
      repositoryPermission: async () => ({ slug: SLUG, permission: 'write', canMerge: true }),
      userAccessToken: async () => 'owner-token',
      brokerCredentials: async () => ({ env: {} }),
    };
    const core = await coreFor({ options: { apiBase: 'https://api.github.test', fetch: fetcher } }, app);
    (await core.store.claimPersonalOrganization('owner'));
    const project = (await core.store.createProject('Wiki divergence'));
    const wiki = (await core.store.upsertRepository({
      organizationId: project.organizationId!, provider: 'github', providerId: 'wiki-93',
      owner: 'acme', name: 'widgets', sshUrl: REMOTE, defaultBranch: 'main', private: true,
    }));
    (await core.store.setProjectWikiRepository(project.id, wiki.id));
    const task = (await core.store.createTask({ projectId: project.id, title: 'Merge wiki memory', workflow: 'software-dev',
      workflowVersion: '1.21.0', params: { prompt: 'x' }, createdBy: { kind: 'user', userId: 'owner' } }));
    const handle = {
      id: task.id, kind: 'worktree', root: repo, workdir: repo, branch: 'tavya/task_wiki', base: 'main',
      repo, meta: { projectId: project.id }, repos: [{ name: 'widgets', role: 'project-wiki', repo, root: repo,
        branch: 'tavya/task_wiki', base: 'main', target: 'main', localPath: repo, sourceAuthority: 'origin' }],
    } as any;
    const ref: TaskPullRequest = { repo: 'widgets', slug: SLUG, number: 93,
      url: 'https://github.test/acme/widgets/pull/93', state: 'open', headSha: landedSha };

    await expect(core.mergeGithubPrs(handle, [ref])).resolves.toMatchObject({ status: 'merged' });
    expect(fs.readFileSync(path.join(repo, 'canonical-memory.md'), 'utf8')).toBe('saved through the live wiki\n');
    expect(fs.readFileSync(path.join(repo, 'task-memory.md'), 'utf8')).toBe('landed through Review\n');
    const reconciledSha = (await gitOrThrow(repo, ['rev-parse', 'main'])).trim();
    expect((await gitOrThrow(repo, ['rev-list', '--parents', '-n', '1', reconciledSha])).trim().split(' ')).toHaveLength(3);
    const origin = path.join(tmp, 'wiki-divergence-after-merge-origin.git');
    expect((await gitOrThrow(origin, ['show', 'main:canonical-memory.md'])).trim()).toBe('saved through the live wiki');
    expect((await gitOrThrow(origin, ['show', 'main:task-memory.md'])).trim()).toBe('landed through Review');
    const events = (await core.store.eventsSince(task.id, 0)).map((event: any) => event.type);
    expect(events).toEqual(expect.arrayContaining(['checkout.synced', 'merge.result']));
    expect(events).not.toContain('checkout.sync-blocked');
  });

  it('completes an authoritative provider merge while preserving a dirty local target checkout', async () => {
    const repo = await repoWithGithubOrigin('dirty-mirror-after-merge');
    const writer = path.join(tmp, 'dirty-provider-writer');
    await gitOrThrow(tmp, ['clone', '-q', path.join(tmp, 'dirty-mirror-after-merge-origin.git'), writer]);
    await ensureIdentity(writer);
    fs.writeFileSync(path.join(writer, 'landed.txt'), 'landed by GitHub\n');
    await gitOrThrow(writer, ['add', '-A']);
    await gitOrThrow(writer, ['commit', '-q', '-m', 'provider merge']);
    await gitOrThrow(writer, ['push', '-q', 'origin', 'main']);
    const landedSha = (await gitOrThrow(writer, ['rev-parse', 'HEAD'])).trim();
    const localBefore = (await gitOrThrow(repo, ['rev-parse', 'main'])).trim();
    fs.writeFileSync(path.join(repo, 'operator-work.txt'), 'preserve me\n');

    const fetcher = (async () => Response.json({
      number: 92, html_url: 'https://github.test/acme/widgets/pull/92', state: 'closed', merged: true,
      merged_at: '2026-08-07T00:00:00Z', merge_commit_sha: landedSha,
      head: { ref: 'tavya/task_dirty_mirror', sha: landedSha }, base: { ref: 'main' },
    })) as typeof fetch;
    const app = {
      activeUserAccountId: () => 'owner-account',
      repositoryPermission: async () => ({ slug: SLUG, permission: 'write', canMerge: true }),
      userAccessToken: async () => 'owner-token',
    };
    const core = await coreFor({ options: { apiBase: 'https://api.github.test', fetch: fetcher } }, app);
    (await core.store.claimPersonalOrganization('owner'));
    const project = (await core.store.createProject('Dirty provider mirror'));
    const task = (await core.store.createTask({ projectId: project.id, title: 'Preserve local work', workflow: 'software-dev',
      workflowVersion: '1.21.0', params: { prompt: 'x' }, createdBy: { kind: 'user', userId: 'owner' } }));
    const handle = {
      id: task.id, kind: 'worktree', root: repo, workdir: repo, branch: 'tavya/task_dirty_mirror', base: 'main',
      repo, meta: { projectId: project.id }, repos: [{ name: 'widgets', repo, root: repo,
        branch: 'tavya/task_dirty_mirror', base: 'main', target: 'main', localPath: repo, sourceAuthority: 'origin' }],
    } as any;
    const ref: TaskPullRequest = { repo: 'widgets', slug: SLUG, number: 92,
      url: 'https://github.test/acme/widgets/pull/92', state: 'open', headSha: landedSha };

    await expect(core.mergeGithubPrs(handle, [ref])).resolves.toMatchObject({
      status: 'merged', sha: landedSha,
      prs: [expect.objectContaining({ number: 92, merged: true, state: 'closed' })],
    });
    expect((await gitOrThrow(repo, ['rev-parse', 'main'])).trim()).toBe(localBefore);
    expect(fs.readFileSync(path.join(repo, 'operator-work.txt'), 'utf8')).toBe('preserve me\n');
    expect((await core.store.eventsSince(task.id, 0)).map((event: any) => event.type)).toContain('checkout.sync-blocked');
  });

  it('uses an eligible confirming human and refuses to move beyond the reviewed head', async () => {
    const requests: Array<{ auth: string; method: string; path: string; body: any }> = [];
    let liveHead = 'reviewed-head';
    const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const auth = new Headers(init.headers).get('authorization') ?? '';
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(String(init.body)) : {};
      requests.push({ auth, method, path: url.pathname, body });
      if (method === 'GET') return Response.json({
        number: 7, node_id: 'PR_node', html_url: 'https://github.test/acme/widgets/pull/7', state: 'open',
        merged: false, head: { ref: 'tavya/task_merge', sha: liveHead }, base: { ref: 'main' },
      });
      if (method === 'PUT' && url.pathname.endsWith('/merge'))
        return Response.json({ merged: true, sha: 'merge-sha', message: 'merged' });
      return Response.json({ message: 'not found' }, { status: 404 });
    }) as typeof fetch;
    const app = {
      activeUserAccountId: (userId: string) => `${userId}-account`,
      repositoryPermission: async (userId: string) => ({ slug: SLUG, permission: userId === 'reviewer' ? 'write' : 'read', canMerge: userId === 'reviewer' }),
      userAccessToken: async (userId: string) => `${userId}-token`,
    };
    const core = await coreFor({ options: { apiBase: 'https://api.github.test', fetch: fetcher } }, app);
    (await core.store.claimPersonalOrganization('owner'));
    const project = (await core.store.createProject('Merge authorization'));
    (await core.store.setOrganizationMembership(project.organizationId!, 'reviewer', 'member'));
    (await core.store.setProjectMembership(project.id, { kind: 'user', userId: 'reviewer' }, 'reviewer'));
    const task = (await core.store.createTask({ projectId: project.id, title: 'Merge me', workflow: 'software-dev',
      workflowVersion: '1.12.0', params: { prompt: 'x', _githubAccountId: 'owner-account' },
      createdBy: { kind: 'user', userId: 'owner' } }));
    (await core.store.appendEvent({ taskId: task.id, type: 'task.confirmation-voted', ts: 1,
      payload: { userId: 'reviewer', satisfied: true, githubMergeAuthorized: true,
        githubPrHeads: [{ slug: SLUG, number: 7, headSha: 'reviewed-head' }] } }));
    const result = await core.mergeGithubPrs({ id: task.id, kind: 'worktree', branch: 'tavya/task_merge',
      base: 'main', repo: tmp, root: tmp } as any, [{ repo: 'widgets', slug: SLUG, number: 7,
      url: 'https://github.test/acme/widgets/pull/7', state: 'open', headSha: 'reviewed-head' }]);
    expect(result).toMatchObject({ status: 'merged', actorUserId: 'reviewer', sha: 'merge-sha' });
    expect(requests.find((request) => request.method === 'PUT')).toMatchObject({
      auth: 'Bearer reviewer-token', body: { sha: 'reviewed-head' },
    });

    liveHead = 'replacement-head';
    const stale = await core.mergeGithubPrs({ id: task.id, kind: 'worktree', branch: 'tavya/task_merge',
      base: 'main', repo: tmp, root: tmp } as any, [{ repo: 'widgets', slug: SLUG, number: 7,
      url: 'https://github.test/acme/widgets/pull/7', state: 'open', headSha: 'reviewed-head' }]);
    expect(stale).toMatchObject({ status: 'stale-review', eligibleUserIds: ['reviewer'] });
    const unapprovedReplacement = await core.mergeGithubPrs({ id: task.id, kind: 'worktree',
      branch: 'tavya/task_merge', base: 'main', repo: tmp, root: tmp } as any, stale.prs);
    expect(unapprovedReplacement).toMatchObject({ status: 'needs-authorizer', eligibleUserIds: ['reviewer'] });
    (await core.store.appendEvent({ taskId: task.id, type: 'task.confirmation-voted', ts: 2,
      payload: { userId: 'reviewer', satisfied: true, githubMergeAuthorized: true,
        githubPrHeads: [{ slug: SLUG, number: 7, headSha: 'replacement-head' }] } }));
    await expect(core.mergeGithubPrs({ id: task.id, kind: 'worktree', branch: 'tavya/task_merge',
      base: 'main', repo: tmp, root: tmp } as any, stale.prs)).resolves.toMatchObject({
        status: 'merged', actorUserId: 'reviewer',
      });
  });

  it('returns a conflicting current proposal to Do instead of attempting a GitHub merge', async () => {
    const methods: string[] = [];
    const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      methods.push(method);
      if (method === 'GET') return Response.json({
        number: 17, node_id: 'PR_conflict', html_url: 'https://github.test/acme/widgets/pull/17', state: 'open',
        merged: false, head: { ref: 'tavya/task_conflict', sha: 'reviewed-head' }, base: { ref: 'main' },
      });
      if (method === 'POST') return Response.json({ data: { repository: { pullRequest: {
        id: 'PR_conflict', url: 'https://github.test/acme/widgets/pull/17', state: 'OPEN', isDraft: false,
        merged: false, headRefOid: 'reviewed-head', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY',
        viewerCanEnableAutoMerge: false, viewerCanMergeAsAdmin: false,
      } } } });
      return Response.json({ message: 'merge must not be attempted' }, { status: 500 });
    }) as typeof fetch;
    const app = {
      activeUserAccountId: () => 'reviewer-account',
      repositoryPermission: async () => ({ slug: SLUG, permission: 'write', canMerge: true }),
      userAccessToken: async () => 'reviewer-token',
    };
    const core = await coreFor({ options: { apiBase: 'https://api.github.test', fetch: fetcher } }, app);
    (await core.store.claimPersonalOrganization('owner'));
    const project = (await core.store.createProject('Conflicting GitHub proposal'));
    (await core.store.setOrganizationMembership(project.organizationId!, 'reviewer', 'member'));
    (await core.store.setProjectMembership(project.id, { kind: 'user', userId: 'reviewer' }, 'reviewer'));
    const task = (await core.store.createTask({ projectId: project.id, title: 'Repair me', workflow: 'software-dev',
      workflowVersion: '1.13.0', params: { prompt: 'x' }, createdBy: { kind: 'user', userId: 'owner' } }));
    (await core.store.appendEvent({ taskId: task.id, type: 'task.confirmation-voted', ts: 1,
      payload: { userId: 'reviewer', satisfied: true, githubMergeAuthorized: true,
        githubPrHeads: [{ slug: SLUG, number: 17, headSha: 'reviewed-head' }] } }));

    await expect(core.mergeGithubPrs({ id: task.id, kind: 'worktree', branch: 'tavya/task_conflict',
      base: 'main', repo: tmp, root: tmp } as any, [{ repo: 'widgets', slug: SLUG, number: 17,
      nodeId: 'PR_conflict', url: 'https://github.test/acme/widgets/pull/17', state: 'open',
      headSha: 'reviewed-head' }])).resolves.toMatchObject({
        status: 'needs-revision', actorUserId: 'reviewer',
        detail: expect.stringMatching(/conflicts with its target/i),
      });
    expect(methods).not.toContain('PUT');
  });

  it('classifies terminal CI, GitHub review, draft/closed PRs, and stale targets instead of polling forever', async () => {
    let liveState: 'open' | 'closed' = 'open';
    let readiness: any = {};
    const methods: string[] = [];
    const fetcher = (async (_input: string | URL | Request, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      methods.push(method);
      if (method === 'GET') return Response.json({
        number: 21, node_id: 'PR_policy', html_url: 'https://github.test/acme/widgets/pull/21', state: liveState,
        merged: false, head: { ref: 'tavya/task_policy', sha: 'reviewed-head' }, base: { ref: 'main' },
      });
      if (method === 'POST') return Response.json({ data: { repository: { pullRequest: {
        id: 'PR_policy', url: 'https://github.test/acme/widgets/pull/21', state: liveState.toUpperCase(),
        isDraft: false, merged: false, headRefOid: 'reviewed-head', mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN', viewerCanEnableAutoMerge: false, viewerCanMergeAsAdmin: false,
        ...readiness,
      } } } });
      return Response.json({ merged: false, message: 'merge must not be attempted' }, { status: 409 });
    }) as typeof fetch;
    const app = {
      activeUserAccountId: () => 'owner-account',
      repositoryPermission: async () => ({ slug: SLUG, permission: 'write', canMerge: true }),
      userAccessToken: async () => 'owner-token',
    };
    const core = await coreFor({ options: { apiBase: 'https://api.github.test', fetch: fetcher } }, app);
    (await core.store.claimPersonalOrganization('owner'));
    const project = (await core.store.createProject('GitHub policy classification'));
    const task = (await core.store.createTask({ projectId: project.id, title: 'Classify me', workflow: 'software-dev',
      workflowVersion: '1.14.0', params: { prompt: 'x', _githubAccountId: 'owner-account' },
      createdBy: { kind: 'user', userId: 'owner' } }));
    const handle = { id: task.id, kind: 'worktree', branch: 'tavya/task_policy', base: 'main', repo: tmp, root: tmp } as any;
    const refs: TaskPullRequest[] = [{ repo: 'widgets', slug: SLUG, number: 21, nodeId: 'PR_policy',
      url: 'https://github.test/acme/widgets/pull/21', state: 'open', headSha: 'reviewed-head' }];

    readiness = { mergeStateStatus: 'UNSTABLE', statusCheckRollup: { state: 'FAILURE', contexts: { nodes: [
      { __typename: 'CheckRun', name: 'unit tests', conclusion: 'FAILURE', detailsUrl: 'https://github.test/checks/21' },
    ] } } };
    await expect(core.mergeGithubPrs(handle, refs)).resolves.toMatchObject({
      status: 'needs-revision', detail: expect.stringMatching(/unit tests.*checks\/21/is),
    });

    readiness = { reviewDecision: 'CHANGES_REQUESTED' };
    await expect(core.mergeGithubPrs(handle, refs)).resolves.toMatchObject({
      status: 'needs-revision', detail: expect.stringMatching(/requested changes/i),
    });

    readiness = { isDraft: true, mergeStateStatus: 'DRAFT' };
    await expect(core.mergeGithubPrs(handle, refs)).resolves.toMatchObject({ status: 'needs-human', detail: expect.stringMatching(/draft/i) });

    readiness = { reviewDecision: 'REVIEW_REQUIRED' };
    await expect(core.mergeGithubPrs(handle, refs)).resolves.toMatchObject({ status: 'needs-human', detail: expect.stringMatching(/requires a GitHub review/i) });
    expect(methods).not.toContain('PUT');
    methods.length = 0;

    readiness = { mergeStateStatus: 'BLOCKED' };
    await expect(core.mergeGithubPrs(handle, refs)).resolves.toMatchObject({ status: 'needs-human', detail: expect.stringMatching(/GitHub policy is blocking/i) });

    readiness = { mergeStateStatus: 'BEHIND' };
    await expect(core.mergeGithubPrs(handle, refs)).resolves.toMatchObject({ status: 'needs-revision', detail: expect.stringMatching(/updated with its target/i) });

    liveState = 'closed';
    readiness = {};
    await expect(core.mergeGithubPrs(handle, refs)).resolves.toMatchObject({ status: 'needs-human', detail: expect.stringMatching(/closed without merging/i) });

    liveState = 'open';
    readiness = { mergeStateStatus: 'BLOCKED', statusCheckRollup: { state: 'PENDING', contexts: { nodes: [] } } };
    await expect(core.mergeGithubPrs(handle, refs)).resolves.toMatchObject({ status: 'waiting', detail: expect.stringMatching(/merge must not be attempted/i) });
    expect(methods).toContain('PUT');
  });

  it('reconciles a cancelled merge-ref run before bounded retry and follows a newer successful run without reopening the PR', async () => {
    const cancellation = 'Canceling since a higher priority waiting request for CI-refs/pull/113/merge exists.';
    let checkSummary = cancellation;
    let inspectionLog = cancellation;
    let cancelledAttempt = 1;
    let newerSucceeded = false;
    let newerActive = false;
    let earlierHeadSucceeded = false;
    let actionsAvailable = true;
    let actionsForbidden = false;
    let readiness: any = { mergeable: 'MERGEABLE', mergeStateStatus: 'UNSTABLE',
      statusCheckRollup: { state: 'FAILURE', contexts: { nodes: [{
        __typename: 'CheckRun', databaseId: 501, name: 'CI', status: 'COMPLETED', conclusion: 'CANCELLED',
        detailsUrl: `https://github.com/${SLUG}/actions/runs/31737743200/job/501`,
      }] } } };
    const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const body = init.body ? JSON.parse(String(init.body)) : {};
      if ((init.method ?? 'GET') === 'GET' && url.pathname.endsWith('/pulls/113')) return Response.json({
        number: 113, node_id: 'PR_preempted', html_url: 'https://github.test/acme/widgets/pull/113', state: 'open',
        merged: false, head: { ref: 'tavya/task_preempted', sha: 'pr-head' }, base: { ref: 'main' },
      });
      if (url.pathname === '/graphql' && String(body.query).includes('PullRequestReadiness'))
        return Response.json({ data: { repository: { pullRequest: {
          id: 'PR_preempted', url: 'https://github.test/acme/widgets/pull/113', state: 'OPEN', isDraft: false,
          merged: false, headRefOid: 'pr-head', baseRefOid: 'base-head', viewerCanEnableAutoMerge: false,
          viewerCanMergeAsAdmin: false, ...readiness,
        } } } });
      if ((init.method ?? 'GET') === 'GET' && url.pathname.endsWith('/check-runs/501'))
        return Response.json({ output: { title: 'Concurrency cancellation', summary: checkSummary } });
      return Response.json({ message: `unexpected ${init.method ?? 'GET'} ${url.pathname}` }, { status: 500 });
    }) as typeof fetch;
    let reruns = 0;
    const actions = {
      inspectFailure: async () => {
        if (actionsForbidden) throw new GithubActionsApiError(403, 'Resource not accessible by integration');
        return {
          run: { id: 31737743200, name: 'CI', workflowId: 9, runNumber: 100, attempt: cancelledAttempt,
            event: 'pull_request', status: 'completed', conclusion: 'cancelled', branch: 'tavya/task_preempted',
            // A pull_request run's head_sha is the PR head it tested.
            headSha: 'pr-head', url: 'https://github.test/run/31737743200',
            createdAt: '2026-08-14T00:00:00Z', updatedAt: '2026-08-14T00:01:00Z' },
          jobs: [], failedJobs: [{ id: 501, name: 'CI', status: 'completed', conclusion: 'cancelled', url: '',
            steps: [], log: { excerpt: inspectionLog, downloadedBytes: inspectionLog.length, truncated: false } }],
          artifacts: [], notices: [],
        };
      },
      listRuns: async () => earlierHeadSucceeded ? { total: 2, page: 1, perPage: 100, runs: [{
        // The previous head's green run. GitHub reports the PR's current head
        // in pull_requests[], but the run tested `earlier-head` (PR #540).
        id: 31737743100, name: 'CI', workflowId: 9, runNumber: 99, attempt: 1,
        event: 'pull_request', status: 'completed', conclusion: 'success', branch: 'tavya/task_preempted',
        headSha: 'earlier-head', url: 'https://github.test/run/31737743100',
        createdAt: '2026-08-13T23:00:00Z', updatedAt: '2026-08-13T23:20:00Z',
        pullRequests: [{ number: 113, headSha: 'pr-head' }],
      }] } : ({ total: newerSucceeded || newerActive ? 2 : 1, page: 1, perPage: 100,
        runs: newerSucceeded || newerActive ? [{
        id: 31737743300, name: 'CI', workflowId: 9, runNumber: 101, attempt: 1,
        event: 'pull_request', status: newerSucceeded ? 'completed' : 'in_progress',
        ...(newerSucceeded ? { conclusion: 'success' } : {}), branch: 'tavya/task_preempted',
        headSha: 'pr-head', url: 'https://github.test/run/31737743300',
        createdAt: '2026-08-14T00:02:00Z', updatedAt: '2026-08-14T00:03:00Z',
        pullRequests: [{ number: 113, headSha: 'pr-head' }],
      }] : [] }),
      rerun: async () => { reruns++; return { accepted: true as const, action: 'rerun-failed' as const }; },
    };
    const app = {
      activeUserAccountId: () => 'owner-account',
      repositoryPermission: async () => ({ slug: SLUG, permission: 'write', canMerge: true }),
      userAccessToken: async () => 'owner-token',
      installationToken: async () => 'installation-token',
      actions: () => actionsAvailable ? actions : undefined,
    };
    const dbPath = path.join(tmp, 'restart-safe.sqlite');
    let core = await coreFor({ options: { apiBase: 'https://api.github.test', fetch: fetcher } }, app, dbPath);
    (await core.store.claimPersonalOrganization('owner'));
    const project = (await core.store.createProject('Superseded PR CI', { landingAuthority: 'auto' }));
    const connection = (await core.store.upsertGitConnection({ organizationId: project.organizationId!, provider: 'github',
      installationId: 'preempted', accountLogin: 'acme', accountType: 'Organization' }));
    const repository = (await core.store.upsertRepository({ organizationId: project.organizationId!, provider: 'github',
      providerId: 'preempted-repo', owner: 'acme', name: 'widgets', sshUrl: REMOTE, defaultBranch: 'main',
      private: true, gitConnectionId: connection.id }));
    (await core.store.attachProjectRepository({ projectId: project.id, repositoryId: repository.id }));
    const task = (await core.store.createTask({ projectId: project.id, title: 'Do not reopen', workflow: 'software-dev',
      workflowVersion: '1.21.0', params: { prompt: 'x', _githubAccountId: 'owner-account' },
      createdBy: { kind: 'user', userId: 'owner' } }));
    (await core.store.appendEvent({ taskId: task.id, type: 'task.confirmation-voted', ts: 1, payload: {
      userId: 'owner', satisfied: true, githubMergeAuthorized: true, githubMergeIntentAuthorized: true,
      githubPrHeads: [{ slug: SLUG, number: 113, headSha: 'pr-head' }],
    } }));
    const handle = { id: task.id, kind: 'worktree', branch: 'tavya/task_preempted', base: 'main', repo: tmp, root: tmp } as any;
    const refs: TaskPullRequest[] = [{ repo: 'widgets', slug: SLUG, number: 113, nodeId: 'PR_preempted',
      url: 'https://github.test/acme/widgets/pull/113', state: 'open', headSha: 'pr-head' }];

    const first = await core.mergeGithubPrs(handle, refs, { mode: 'preflight', authority: 'auto' });
    const repeated = await core.mergeGithubPrs(handle, refs, { mode: 'preflight', authority: 'auto' });
    expect(first).toMatchObject({ status: 'waiting',
      detail: expect.stringMatching(/bounded exact-head reconciliation/is) });
    expect(first).not.toHaveProperty('releaseAdmission');
    expect(repeated).toMatchObject({ status: 'waiting',
      detail: 'Waiting for CI' });
    expect(repeated).not.toHaveProperty('releaseAdmission');
    expect((await core.store.eventsSince(task.id, 0))
      .filter((event) => event.type === 'github.ci.terminal-observed')).toHaveLength(1);
    expect(reruns).toBe(1);

    earlierHeadSucceeded = true;
    await expect(core.mergeGithubPrs(handle, refs, { mode: 'preflight', authority: 'auto' })).resolves
      .not.toMatchObject({ status: 'planned' });
    expect((await core.store.eventsSince(task.id, 0)).filter((event) => event.type === 'github.ci.superseded')).toEqual([]);
    earlierHeadSucceeded = false;

    newerActive = true;
    await expect(core.mergeGithubPrs(handle, refs, { mode: 'preflight', authority: 'auto' })).resolves.toMatchObject({
      status: 'waiting', detail: expect.stringMatching(/equivalent same-head.*31737743300.*in_progress/is),
    });
    expect(reruns).toBe(1);

    newerSucceeded = true;
    await expect(core.mergeGithubPrs(handle, refs, { mode: 'preflight', authority: 'auto' })).resolves.toMatchObject({
      status: 'planned', detail: expect.stringMatching(/passed.*preflight/is),
    });

    // A genuinely current cancellation receives bounded reconciliation, then
    // one retry when no same-head replacement exists. Persisted observations
    // survive each fresh activity invocation and duplicate polls do not create
    // duplicate rerun requests. Billing fixture strings in the cancelled job's
    // log are not direct GitHub account evidence.
    newerActive = false;
    newerSucceeded = false;
    cancelledAttempt = 2;
    checkSummary = 'The operation was canceled.';
    inspectionLog = "passing fixture: You're out of usage credits. Your prepaid balance has now been fully consumed.\nThe operation was canceled.";
    const bounded = await core.mergeGithubPrs(handle, refs, { mode: 'preflight', authority: 'auto' });
    expect(bounded).toMatchObject({ status: 'waiting', detail: expect.stringMatching(/bounded exact-head reconciliation/i) });
    expect(reruns).toBe(1);
    (await core.store.close());
    core = await coreFor({ options: { apiBase: 'https://api.github.test', fetch: fetcher } }, app, dbPath);
    await expect(core.mergeGithubPrs(handle, refs, { mode: 'preflight', authority: 'auto' })).resolves.toMatchObject({
      status: 'waiting', detail: 'Waiting for CI',
    });
    expect(reruns).toBe(2);
    await core.mergeGithubPrs(handle, refs, { mode: 'preflight', authority: 'auto' });
    expect(reruns).toBe(2);

    // No diagnostic text is promoted to authority when Actions access is
    // missing, even when it looks exactly like a provider message.
    actionsAvailable = false;
    readiness = { mergeable: 'MERGEABLE', mergeStateStatus: 'UNSTABLE',
      statusCheckRollup: { state: 'FAILURE', contexts: { nodes: [{
        __typename: 'StatusContext', context: 'CI', state: 'FAILURE',
        targetUrl: `https://github.com/${SLUG}/actions/runs/44`, description: cancellation,
      }] } } };
    const spoofed = [cancellation, 'Recent account payments have failed',
      'The job was not started because your account is locked due to a billing issue.',
      'Actions is disabled for this repository', 'AssertionError: expected 2 to equal 3'];
    for (const available of [false, true]) {
      actionsAvailable = available;
      actionsForbidden = true;
      for (const description of spoofed) {
        readiness.statusCheckRollup.contexts.nodes[0].description = description;
        const outcome = await core.mergeGithubPrs(handle, refs, { mode: 'preflight', authority: 'auto' });
        expect(outcome).toMatchObject({ status: 'needs-human', releaseAdmission: true,
          waitReason: 'GitHub Actions inspection unavailable' });
        expect(outcome.detail).toContain(description);
        expect(outcome.waitReason).not.toMatch(/billing|approval/);
      }
    }
    expect((await core.store.eventsSince(task.id, 0)).filter(event => event.type === 'github.ci.repair-requested')).toHaveLength(0);
    readiness.statusCheckRollup.contexts.nodes = [{ __typename: 'CheckRun', name: 'CI',
      status: 'COMPLETED', conclusion: 'CANCELLED', detailsUrl: `https://github.com/${SLUG}/actions/runs/44` }];
    await expect(core.mergeGithubPrs(handle, refs, { mode: 'preflight', authority: 'auto' })).resolves.toMatchObject({
      status: 'waiting', releaseAdmission: true, detail: expect.stringMatching(/interrupted check.*admission is released/is),
    });
    readiness.statusCheckRollup.contexts.nodes[0].conclusion = 'ACTION_REQUIRED';
    await expect(core.mergeGithubPrs(handle, refs, { mode: 'preflight', authority: 'auto' })).resolves.toMatchObject({
      status: 'needs-human', waitReason: 'GitHub Actions action required',
    });
  });

  it('recognizes a recorded legacy conflict wait without mistaking pending GitHub work for a repair', async () => {
    const { githubWaitNeedsProposalRevision, landingRepairProgress, landingRepairExhaustionDetail } =
      await import('../src/workflows/software-dev.js');

    expect(githubWaitNeedsProposalRevision({
      status: 'waiting',
      detail: 'Pull Request has merge conflicts',
    })).toBe(true);
    expect(githubWaitNeedsProposalRevision({
      status: 'waiting',
      detail: 'GitHub says the branch is conflicting with the target branch.',
    })).toBe(true);
    expect(githubWaitNeedsProposalRevision({
      status: 'waiting',
      detail: 'Required status checks are pending.',
    })).toBe(false);
    expect(githubWaitNeedsProposalRevision({
      status: 'queued',
      detail: 'Pull Request has merge conflicts',
    })).toBe(false);

    const unchanged = landingRepairProgress({
      authorization: 'authorized', validation: 'failed', provider: 'ejected',
      repairAttempts: 1, lastRepairFingerprint: 'ci:head-a:run-42:attempt-1',
    }, { kind: 'ci', preserveAuthorization: true, fingerprint: 'ci:head-a:run-42:attempt-1' });
    expect(unchanged).toMatchObject({ attempts: 1, duplicate: true });

    let landing: any = { authorization: 'authorized', validation: 'failed', provider: 'ejected', repairAttempts: 0 };
    for (let base = 1; base <= 5; base++) {
      const progress = landingRepairProgress(landing, {
        kind: 'conflict', preserveAuthorization: true, fingerprint: `conflict:head-${base}:base-${base}`,
      });
      expect(progress.duplicate).toBe(false);
      landing = { ...landing, repairAttempts: progress.attempts,
        lastRepairFingerprint: progress.lastRepairFingerprint };
    }
    expect(landing.repairAttempts).toBe(5);
    expect(landingRepairExhaustionDetail(landing.repairAttempts, {
      kind: 'conflict', preserveAuthorization: true,
    }, 'The target rejected the fifth distinct repaired head.', false)).toMatch(
      /exhausted 5 substantive.*Last cause: conflict.*fifth distinct repaired head.*outside every queue/is,
    );
    expect(landingRepairExhaustionDetail(5, {
      kind: 'conflict', preserveAuthorization: true,
    }, 'conflict', false)).not.toMatch(/target kept moving/i);
  });

  it('returns an explicit merge-conflict refusal to Do for legacy pinned tasks and does not repeat impossible self-approval', async () => {
    let reviewPosts = 0;
    let mergeMessage = 'Pull Request has merge conflicts';
    const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const method = init.method ?? 'GET';
      if (method === 'GET') return Response.json({
        number: 23, node_id: 'PR_legacy_conflict', html_url: 'https://github.test/acme/widgets/pull/23', state: 'open',
        merged: false, head: { ref: 'tavya/task_legacy_conflict', sha: 'reviewed-head' }, base: { ref: 'main' },
      });
      if (url.pathname.endsWith('/reviews')) {
        reviewPosts++;
        return Response.json({ message: 'Review Can not approve your own pull request' }, { status: 422 });
      }
      if (url.pathname === '/graphql') {
        const body = JSON.parse(String(init.body ?? '{}'));
        if (String(body.query).includes('PullRequestReadiness')) return Response.json({ data: { repository: { pullRequest: {
          id: 'PR_legacy_conflict', url: 'https://github.test/acme/widgets/pull/23', state: 'OPEN', isDraft: false,
          merged: false, headRefOid: 'reviewed-head', mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN',
          viewerCanEnableAutoMerge: false, viewerCanMergeAsAdmin: false,
        } } } });
        return Response.json({ errors: [{ message: mergeMessage }] });
      }
      if (method === 'PUT') return Response.json({ merged: false, message: mergeMessage }, { status: 409 });
      return Response.json({ message: 'unexpected request' }, { status: 500 });
    }) as typeof fetch;
    const app = {
      activeUserAccountId: () => 'owner-account',
      repositoryPermission: async () => ({ slug: SLUG, permission: 'write', canMerge: true }),
      userAccessToken: async () => 'owner-token',
    };
    const core = await coreFor({ options: { apiBase: 'https://api.github.test', fetch: fetcher } }, app);
    (await core.store.claimPersonalOrganization('owner'));
    const project = (await core.store.createProject('Legacy GitHub conflict'));
    const task = (await core.store.createTask({ projectId: project.id, title: 'Unstick me', workflow: 'software-dev',
      workflowVersion: '1.12.0', params: { prompt: 'x', _githubAccountId: 'owner-account' },
      createdBy: { kind: 'user', userId: 'owner' } }));
    (await core.store.appendEvent({ taskId: task.id, type: 'task.confirmation-voted', ts: 1,
      payload: { userId: 'owner', satisfied: true, githubMergeAuthorized: true,
        githubPrHeads: [{ slug: SLUG, number: 23, headSha: 'reviewed-head' }] } }));
    const ref = { repo: 'widgets', slug: SLUG, number: 23, nodeId: 'PR_legacy_conflict',
      url: 'https://github.test/acme/widgets/pull/23', state: 'open', headSha: 'reviewed-head' } as TaskPullRequest;
    const handle = { id: task.id, kind: 'worktree', branch: 'tavya/task_legacy_conflict', base: 'main', repo: tmp, root: tmp } as any;

    await expect(core.mergeGithubPrs(handle, [ref])).resolves.toMatchObject({
      status: 'needs-revision',
      detail: expect.stringMatching(/conflicts with its target.*Pull Request has merge conflicts/is),
    });
    await expect(core.mergeGithubPrs(handle, [ref])).resolves.toMatchObject({ status: 'needs-revision' });
    expect(reviewPosts).toBe(1);

    mergeMessage = 'GitHub could not determine whether this pull request is mergeable';
    await expect(core.mergeGithubPrs(handle, [ref])).resolves.toMatchObject({
      status: 'retryable-error', detail: expect.stringMatching(/could not determine/i),
    });
    expect(reviewPosts).toBe(1);
  });

  it('v1.16 preserves intent across repairable failures and hands durable queueing to GitHub', async () => {
    let liveHead = 'reviewed-head';
    let readiness: any = { mergeStateStatus: 'CLEAN', statusCheckRollup: { state: 'SUCCESS', contexts: { nodes: [] } } };
    let denyChecks = false;
    let queueEnabled = true;
    let refUpdateMessage: string | undefined;
    const requests: Array<{ method: string; path: string; query?: string }> = [];
    const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(String(init.body)) : {};
      requests.push({ method, path: url.pathname, query: body.query });
      if (method === 'GET') return Response.json({
        number: 31, node_id: 'PR_landing', html_url: 'https://github.test/acme/widgets/pull/31', state: 'open',
        merged: false, head: { ref: 'tavya/task_landing', sha: liveHead }, base: { ref: 'main' },
      });
      if (url.pathname === '/graphql' && String(body.query).includes('PullRequestReadiness')) {
        if (denyChecks && String(body.query).includes('statusCheckRollup'))
          return Response.json({ errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }] });
        return Response.json({ data: { repository: { pullRequest: {
          id: 'PR_landing', url: 'https://github.test/acme/widgets/pull/31', state: 'OPEN', isDraft: false,
          merged: false, headRefOid: liveHead, mergeable: 'MERGEABLE', viewerCanEnableAutoMerge: false,
          viewerCanMergeAsAdmin: false, ...readiness,
        } } } });
      }
      if (url.pathname.endsWith('/reviews')) return Response.json({ id: 1 });
      if (method === 'PUT') return Response.json({ merged: false, message: 'merge queue required' }, { status: 409 });
      if (url.pathname === '/graphql' && String(body.query).includes('enqueuePullRequest')) {
        if (!queueEnabled) return Response.json({ errors: [{ message: 'This branch has no merge queue' }] });
        return Response.json({ data: { enqueuePullRequest: { mergeQueueEntry: { id: 'MQ_31' } } } });
      }
      if (method === 'PATCH' && url.pathname.endsWith('/git/refs/heads/main')) {
        if (refUpdateMessage) return Response.json({ message: refUpdateMessage }, { status: 422 });
        return Response.json({ ref: 'refs/heads/main', object: { sha: body.sha } });
      }
      return Response.json({ message: 'unexpected request' }, { status: 500 });
    }) as typeof fetch;
    const app = {
      activeUserAccountId: () => 'reviewer-account',
      repositoryPermission: async () => ({ slug: SLUG, permission: 'write', canMerge: true }),
      userAccessToken: async () => 'reviewer-token',
    };
    const core = await coreFor({ options: { apiBase: 'https://api.github.test', fetch: fetcher } }, app);
    (await core.store.claimPersonalOrganization('owner'));
    const project = (await core.store.createProject('Intent-authorized landing'));
    (await core.store.setOrganizationMembership(project.organizationId!, 'reviewer', 'member'));
    (await core.store.setProjectMembership(project.id, { kind: 'user', userId: 'reviewer' }, 'reviewer'));
    const task = (await core.store.createTask({ projectId: project.id, title: 'Land me', workflow: 'software-dev',
      workflowVersion: '1.16.0', params: { prompt: 'x' }, createdBy: { kind: 'user', userId: 'owner' } }));
    (await core.store.appendEvent({ taskId: task.id, type: 'task.confirmation-voted', ts: 1, payload: {
      userId: 'reviewer', satisfied: true, githubMergeAuthorized: true, githubMergeIntentAuthorized: true,
      githubPrHeads: [{ slug: SLUG, number: 31, headSha: 'reviewed-head' }],
    } }));
    const handle = { id: task.id, kind: 'worktree', branch: 'tavya/task_landing', base: 'main', repo: tmp, root: tmp } as any;
    const refs: TaskPullRequest[] = [{ repo: 'widgets', slug: SLUG, number: 31, nodeId: 'PR_landing',
      url: 'https://github.test/acme/widgets/pull/31', state: 'open', headSha: 'reviewed-head' }];

    readiness = { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' };
    await expect(core.mergeGithubPrs(handle, refs)).resolves.toMatchObject({
      status: 'needs-revision', repair: { kind: 'conflict', preserveAuthorization: true },
    });

    readiness = { mergeStateStatus: 'UNSTABLE', statusCheckRollup: { state: 'FAILURE', contexts: { nodes: [] } } };
    await expect(core.mergeGithubPrs(handle, refs)).resolves.toMatchObject({
      status: 'needs-revision', repair: { kind: 'ci', preserveAuthorization: true },
    });

    readiness = { mergeStateStatus: 'CLEAN', reviewDecision: 'CHANGES_REQUESTED' };
    await expect(core.mergeGithubPrs(handle, refs)).resolves.toMatchObject({
      status: 'needs-revision', repair: { kind: 'changes-requested', preserveAuthorization: false },
    });

    // A new full Review restores intent authorization after CHANGES_REQUESTED.
    (await core.store.appendEvent({ taskId: task.id, type: 'task.confirmation-voted', ts: 2, payload: {
      userId: 'reviewer', satisfied: true, githubMergeAuthorized: true, githubMergeIntentAuthorized: true,
      githubPrHeads: [{ slug: SLUG, number: 31, headSha: 'reviewed-head' }],
    } }));
    readiness = { mergeStateStatus: 'BEHIND', statusCheckRollup: { state: 'SUCCESS', contexts: { nodes: [] } } };
    await expect(core.mergeGithubPrs(handle, refs, { mode: 'submit' })).resolves.toMatchObject({
      status: 'queued', providerQueue: { state: 'queued' },
    });
    expect(requests.some((request) => request.query?.includes('enqueuePullRequest'))).toBe(true);

    const mutationsBeforeObserve = requests.filter((request) => request.method === 'PUT'
      || request.query?.includes('enqueuePullRequest')).length;
    readiness = { mergeStateStatus: 'CLEAN', mergeQueueEntry: { id: 'MQ_31' },
      statusCheckRollup: { state: 'PENDING', contexts: { nodes: [] } } };
    await expect(core.mergeGithubPrs(handle, refs, { mode: 'observe' })).resolves.toMatchObject({
      status: 'queued', providerQueue: { state: 'validating', entryIds: ['MQ_31'] },
    });
    expect(requests.filter((request) => request.method === 'PUT'
      || request.query?.includes('enqueuePullRequest')).length).toBe(mutationsBeforeObserve);

    readiness = { mergeStateStatus: 'CLEAN', statusCheckRollup: { state: 'SUCCESS', contexts: { nodes: [] } } };
    await expect(core.mergeGithubPrs(handle, refs, { mode: 'observe' })).resolves.toMatchObject({
      status: 'needs-revision',
      repair: { kind: 'ci', preserveAuthorization: true },
      detail: expect.stringMatching(/ejected.*merge-group checks/is),
    });

    // Without a native queue, land only the exact tested head. A target race is
    // an automatic base repair—not a direct PR merge against an unbound base.
    queueEnabled = false;
    readiness = { mergeStateStatus: 'CLEAN', statusCheckRollup: { state: 'SUCCESS', contexts: { nodes: [] } } };
    await expect(core.mergeGithubPrs(handle, refs, { mode: 'submit' })).resolves.toMatchObject({
      status: 'merged', sha: 'reviewed-head',
    });
    expect(requests.some((request) => request.method === 'PATCH'
      && request.path.endsWith('/git/refs/heads/main'))).toBe(true);
    expect(requests.some((request) => request.method === 'PUT')).toBe(false);

    refUpdateMessage = 'Update is not a fast forward';
    await expect(core.mergeGithubPrs(handle, refs, { mode: 'submit' })).resolves.toMatchObject({
      status: 'needs-revision', repair: { kind: 'base-moved', preserveAuthorization: true },
    });

    liveHead = 'repaired-head';
    readiness = { mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED',
      statusCheckRollup: { state: 'SUCCESS', contexts: { nodes: [] } } };
    await expect(core.mergeGithubPrs(handle, [{ ...refs[0]!, headSha: 'repaired-head' }], { mode: 'submit' }))
      .resolves.toMatchObject({
        status: 'needs-human',
        detail: expect.stringMatching(/fresh human approval.*parked outside the provider queue/is),
      });

    // v1.17 separates read-only exact-candidate certification from the atomic
    // landing mutation and never asks GitHub's provider queue to own ordering.
    liveHead = 'reviewed-head';
    readiness = { mergeStateStatus: 'CLEAN', statusCheckRollup: { state: 'SUCCESS', contexts: { nodes: [] } } };
    refUpdateMessage = undefined;
    const task17 = (await core.store.createTask({ projectId: project.id, title: 'Front-held landing', workflow: 'software-dev',
      workflowVersion: '1.17.0', params: { prompt: 'x' }, createdBy: { kind: 'user', userId: 'owner' } }));
    (await core.store.appendEvent({ taskId: task17.id, type: 'task.confirmation-voted', ts: 3, payload: {
      userId: 'reviewer', satisfied: true, githubMergeAuthorized: true, githubMergeIntentAuthorized: true,
      githubPrHeads: [{ slug: SLUG, number: 31, headSha: 'reviewed-head' }],
    } }));
    const handle17 = { ...handle, id: task17.id };
    const enqueueBefore = requests.filter((request) => request.query?.includes('enqueuePullRequest')).length;
    const patchBefore = requests.filter((request) => request.method === 'PATCH').length;
    readiness = { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN',
      statusCheckRollup: { state: 'SUCCESS', contexts: { nodes: [] } } };
    await expect(core.mergeGithubPrs(handle17, refs, { mode: 'inspect-exact' })).resolves.toMatchObject({
      status: 'waiting', detail: expect.stringMatching(/still computing mergeability.*retains the front landing slot.*retry automatically/is),
    });
    expect(requests.filter((request) => request.query?.includes('enqueuePullRequest')).length).toBe(enqueueBefore);
    expect(requests.filter((request) => request.method === 'PATCH').length).toBe(patchBefore);
    readiness = { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
      statusCheckRollup: { state: 'SUCCESS', contexts: { nodes: [] } } };
    await expect(core.mergeGithubPrs(handle17, refs, { mode: 'inspect-exact' })).resolves.toMatchObject({
      status: 'candidate-ready', prs: [expect.objectContaining({ headSha: 'reviewed-head' })],
    });
    denyChecks = true;
    await expect(core.mergeGithubPrs(handle17, refs, { mode: 'inspect-exact' })).resolves.toMatchObject({
      status: 'waiting', detail: expect.stringMatching(/read access to CI.*Checks and Commit statuses.*retry automatically/is),
    });
    denyChecks = false;
    expect(requests.filter((request) => request.query?.includes('enqueuePullRequest')).length).toBe(enqueueBefore);
    expect(requests.filter((request) => request.method === 'PATCH').length).toBe(patchBefore);
    refUpdateMessage = 'Update is not a fast forward';
    await expect(core.mergeGithubPrs(handle17, refs, { mode: 'submit-exact' })).resolves.toMatchObject({
      status: 'needs-revision', repair: { kind: 'base-moved', preserveAuthorization: true },
    });
    refUpdateMessage = undefined;
    await expect(core.mergeGithubPrs(handle17, refs, { mode: 'submit-exact' })).resolves.toMatchObject({
      status: 'merged', sha: 'reviewed-head',
    });
    expect(requests.filter((request) => request.query?.includes('enqueuePullRequest')).length).toBe(enqueueBefore);
  });

  it('v1.20 treats behind as mechanical fallback admission and failures as ejection', async () => {
    let liveHead = 'reviewed-head';
    let speculativeConclusion = 'failure';
    let readiness: any = { mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND',
      statusCheckRollup: { state: 'SUCCESS', contexts: { nodes: [] } } };
    const mutations: string[] = [];
    const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(String(init.body)) : {};
      if (method === 'GET' && url.pathname.endsWith('/pulls/40')) return Response.json({
        number: 40, node_id: 'PR_fair', html_url: 'https://github.test/acme/widgets/pull/40', state: 'open',
        merged: false, head: { ref: 'tavya/task_fair', sha: liveHead }, base: { ref: 'main' },
      });
      if (method === 'GET' && url.pathname.endsWith('/commits/merge-group-failure/check-runs'))
        return Response.json({ check_runs: [{ id: 501, name: 'speculative CI', conclusion: speculativeConclusion,
          details_url: 'https://github.test/checks/501' }] });
      if (method === 'GET' && url.pathname.endsWith('/commits/merge-group-failure/status'))
        return Response.json({ statuses: [] });
      if (method === 'GET' && url.pathname.endsWith('/check-runs/501/annotations'))
        return Response.json([{ path: 'src/prefix.ts', start_line: 7, message: 'prefix assertion failed: expected "recent account payments have failed" and "requires approval"' }]);
      if (method === 'GET' && url.pathname.endsWith('/check-runs/501'))
        return Response.json({ output: { title: 'Queue build failed', summary: 'A + B is incompatible' } });
      if (url.pathname === '/graphql' && String(body.query).includes('PullRequestReadiness'))
        return Response.json({ data: { repository: { pullRequest: {
          id: 'PR_fair', url: 'https://github.test/acme/widgets/pull/40', state: 'OPEN', isDraft: false,
          merged: false, headRefOid: liveHead, viewerCanEnableAutoMerge: false,
          viewerCanMergeAsAdmin: false, ...readiness,
        } } } });
      if (url.pathname === '/graphql' && String(body.query).includes('enqueuePullRequest')) {
        mutations.push('enqueue');
        return Response.json({ errors: [{ message: 'This branch has no merge queue' }] });
      }
      if (url.pathname.endsWith('/update-branch')) {
        mutations.push('update');
        expect(body).toEqual({ expected_head_sha: 'reviewed-head' });
        liveHead = 'mechanically-updated-head';
        return Response.json({ message: 'Updating pull request branch.' }, { status: 202 });
      }
      if (url.pathname.endsWith('/reviews')) return Response.json({ id: 1 });
      return Response.json({ errors: [{ message: 'Auto-merge unavailable' }] });
    }) as typeof fetch;
    const app = {
      activeUserAccountId: () => 'reviewer-account',
      repositoryPermission: async () => ({ slug: SLUG, permission: 'write', canMerge: true }),
      userAccessToken: async () => 'reviewer-token',
    };
    const core = await coreFor({ options: { apiBase: 'https://api.github.test', fetch: fetcher } }, app);
    (await core.store.claimPersonalOrganization('owner'));
    const project = (await core.store.createProject('Fair landing', { landingAuthority: 'auto' }));
    (await core.store.setOrganizationMembership(project.organizationId!, 'reviewer', 'member'));
    (await core.store.setProjectMembership(project.id, { kind: 'user', userId: 'reviewer' }, 'reviewer'));
    const task = (await core.store.createTask({ projectId: project.id, title: 'Land fairly', workflow: 'software-dev',
      workflowVersion: '1.20.0', params: { prompt: 'x' }, createdBy: { kind: 'user', userId: 'owner' } }));
    (await core.store.appendEvent({ taskId: task.id, type: 'task.confirmation-voted', ts: 1, payload: {
      userId: 'reviewer', satisfied: true, githubMergeAuthorized: true, githubMergeIntentAuthorized: true,
      githubPrHeads: [{ slug: SLUG, number: 40, headSha: 'reviewed-head' }],
    } }));
    const handle = { id: task.id, kind: 'worktree', branch: 'tavya/task_fair', base: 'main', repo: tmp, root: tmp } as any;
    const refs: TaskPullRequest[] = [{ repo: 'widgets', slug: SLUG, number: 40, nodeId: 'PR_fair',
      url: 'https://github.test/acme/widgets/pull/40', state: 'open', headSha: 'reviewed-head' }];

    const updated = await core.mergeGithubPrs(handle, refs, { mode: 'submit', authority: 'auto' });
    expect(updated).toMatchObject({
      status: 'waiting', landingOwner: 'karmax',
      prs: [expect.objectContaining({ headSha: 'mechanically-updated-head' })],
      detail: expect.stringMatching(/mechanically updated.*fallback admission/is),
    });
    expect(mutations).toEqual(['enqueue', 'update']);

    readiness = { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
      statusCheckRollup: { state: 'SUCCESS', contexts: { nodes: [] } } };
    const beforeHandoff = [...mutations];
    await expect(core.mergeGithubPrs(handle, updated.prs, { mode: 'observe', authority: 'auto' }))
      .resolves.toMatchObject({
        status: 'waiting', landingOwner: 'karmax',
        detail: expect.stringMatching(/no longer reports an active landing entry.*fallback admission/is),
      });
    expect(mutations).toEqual(beforeHandoff);

    readiness = { mergeable: 'MERGEABLE', mergeStateStatus: 'UNSTABLE',
      statusCheckRollup: { state: 'FAILURE', contexts: { nodes: [{
        __typename: 'StatusContext', context: 'test', state: 'FAILURE', description: 'assertion failed',
      }] } } };
    const failed = await core.mergeGithubPrs(handle, updated.prs, { mode: 'submit', authority: 'auto' });
    expect(failed).toMatchObject({
      status: 'needs-revision', repair: { kind: 'ci', preserveAuthorization: true },
    });
    expect(failed).not.toHaveProperty('landingOwner');

    const enqueuedAt = Date.now();
    (await core.store.appendEvent({ taskId: task.id, type: 'github.pr.queued', ts: enqueuedAt, payload: {
      slug: SLUG, number: 40, headSha: 'mechanically-updated-head',
    } }));
    readiness = { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
      statusCheckRollup: { state: 'SUCCESS', contexts: { nodes: [] } },
      timelineItems: { nodes: [{ createdAt: new Date(enqueuedAt + 1_000).toISOString(),
        reason: 'Required status check failed', beforeCommit: { oid: 'merge-group-failure' } }] } };
    const ejected = await core.mergeGithubPrs(handle, updated.prs, { mode: 'observe', authority: 'auto' });
    expect(ejected).toMatchObject({
      status: 'needs-revision', repair: { kind: 'ci', preserveAuthorization: true },
      detail: expect.stringMatching(/Required status check failed.*merge-group-failure.*speculative CI.*A \+ B is incompatible.*src\/prefix\.ts:7/is),
    });
    expect(ejected).not.toHaveProperty('landingOwner');

    readiness = { ...readiness, timelineItems: { nodes: [{ createdAt: new Date(enqueuedAt + 2_000).toISOString(),
      reason: 'Canceling since a higher priority waiting request for CI-refs/pull/40/merge exists.',
      beforeCommit: { oid: 'merge-group-failure' } }] } };
    const superseded = await core.mergeGithubPrs(handle, updated.prs, { mode: 'observe', authority: 'auto' });
    expect(superseded).toMatchObject({
      status: 'needs-revision',
      detail: expect.stringMatching(/higher priority waiting request.*prefix assertion failed/is),
    });
    expect(superseded).not.toHaveProperty('releaseAdmission');
    speculativeConclusion = 'action_required';
    await expect(core.mergeGithubPrs(handle, updated.prs, { mode: 'observe', authority: 'auto' }))
      .resolves.toMatchObject({ status: 'needs-human', waitReason: 'GitHub Actions action required', releaseAdmission: true });
    speculativeConclusion = 'startup_failure';
    await expect(core.mergeGithubPrs(handle, updated.prs, { mode: 'observe', authority: 'auto' }))
      .resolves.toMatchObject({ status: 'needs-human', waitReason: 'GitHub Actions failure needs inspection', releaseAdmission: true });
    speculativeConclusion = 'cancelled';
    await expect(core.mergeGithubPrs(handle, updated.prs, { mode: 'observe', authority: 'auto' }))
      .resolves.toMatchObject({ status: 'retryable-error', releaseAdmission: true });
  });

  it('v1.20 observes an explicitly external landing authority without shadow mutations', async () => {
    const mutations: string[] = [];
    const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(String(init.body)) : {};
      if (url.pathname.endsWith('/update-branch') || url.pathname.endsWith('/merge')
        || String(body.query).includes('enqueuePullRequest') || String(body.query).includes('enablePullRequestAutoMerge'))
        mutations.push(`${method} ${url.pathname}`);
      if (method === 'GET') return Response.json({ number: 41, node_id: 'PR_external',
        html_url: 'https://github.test/acme/widgets/pull/41', state: 'open', merged: false,
        head: { ref: 'tavya/task_external', sha: 'external-head' }, base: { ref: 'main' } });
      if (url.pathname === '/graphql' && String(body.query).includes('PullRequestReadiness'))
        return Response.json({ data: { repository: { pullRequest: {
          id: 'PR_external', url: 'https://github.test/acme/widgets/pull/41', state: 'OPEN', isDraft: false,
          merged: false, headRefOid: 'external-head', mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND',
          statusCheckRollup: { state: 'PENDING', contexts: { nodes: [] } },
          viewerCanEnableAutoMerge: false, viewerCanMergeAsAdmin: false,
        } } } });
      if (url.pathname.endsWith('/reviews')) return Response.json({ id: 1 });
      return Response.json({ message: 'unexpected mutation' }, { status: 500 });
    }) as typeof fetch;
    const app = {
      activeUserAccountId: () => 'owner-account',
      repositoryPermission: async () => ({ slug: SLUG, permission: 'write', canMerge: true }),
      userAccessToken: async () => 'owner-token',
    };
    const core = await coreFor({ options: { apiBase: 'https://api.github.test', fetch: fetcher } }, app);
    (await core.store.claimPersonalOrganization('owner'));
    const project = (await core.store.createProject('External landing', { landingAuthority: 'external' }));
    const task = (await core.store.createTask({ projectId: project.id, title: 'Observe me', workflow: 'software-dev',
      workflowVersion: '1.20.0', params: { prompt: 'x' }, createdBy: { kind: 'user', userId: 'owner' } }));
    const ref = { repo: 'widgets', slug: SLUG, number: 41, nodeId: 'PR_external',
      url: 'https://github.test/acme/widgets/pull/41', state: 'open', headSha: 'external-head' } as TaskPullRequest;

    await expect(core.mergeGithubPrs({ id: task.id } as any, [ref], { mode: 'submit', authority: 'external' }))
      .resolves.toMatchObject({ status: 'queued', landingOwner: 'external' });
    expect(mutations).toEqual([]);
  });

  it('v1.21 preflights every PR before claiming any provider and assigns canonical owners per target', async () => {
    const mutations: string[] = [];
    let secondFails = true;
    let checksPending = false;
    const headFor = (number: number) => number === 51 ? 'head-a' : 'head-b';
    const slugFor = (number: number) => number === 51 ? 'acme/service-a' : 'acme/service-b';
    const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(String(init.body)) : {};
      const pull = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/);
      if (method === 'GET' && pull) {
        const number = Number(pull[2]);
        return Response.json({ number, node_id: `PR_${number}`, html_url: `https://github.test/${pull[1]}/pull/${number}`,
          state: 'open', merged: false, head: { ref: `tavya/task-${number}`, sha: headFor(number) }, base: { ref: 'main' } });
      }
      if (url.pathname === '/graphql' && String(body.query).includes('PullRequestReadiness')) {
        const number = Number(body.variables?.number);
        const failing = secondFails && number === 52;
        return Response.json({ data: { repository: { pullRequest: {
          id: `PR_${number}`, url: `https://github.test/${slugFor(number)}/pull/${number}`, state: 'OPEN', isDraft: false,
          merged: false, headRefOid: headFor(number), mergeable: 'MERGEABLE', mergeStateStatus: failing ? 'UNSTABLE' : 'CLEAN',
          statusCheckRollup: { state: failing ? 'FAILURE' : checksPending ? 'PENDING' : 'SUCCESS', contexts: { nodes: [] } },
          viewerCanEnableAutoMerge: false, viewerCanMergeAsAdmin: false,
        } } } });
      }
      if (url.pathname === '/graphql' && String(body.query).includes('enqueuePullRequest')) {
        const id = body.variables?.input?.pullRequestId;
        mutations.push(`enqueue:${id}`);
        return id === 'PR_51'
          ? Response.json({ data: { enqueuePullRequest: { mergeQueueEntry: { id: 'MQ_51' } } } })
          : Response.json({ data: { enqueuePullRequest: { mergeQueueEntry: null } } });
      }
      if (url.pathname === '/graphql' && String(body.query).includes('enablePullRequestAutoMerge')) {
        mutations.push(`auto:${body.variables?.input?.pullRequestId}`);
        return Response.json({ errors: [{ message: 'Auto-merge unavailable' }] });
      }
      if (url.pathname === '/graphql' && String(body.query).includes('dequeuePullRequest')) {
        mutations.push(`dequeue:${body.variables?.input?.pullRequestId}`);
        return Response.json({ data: { dequeuePullRequest: { mergeQueueEntry: null } } });
      }
      if (url.pathname === '/graphql' && String(body.query).includes('disablePullRequestAutoMerge')) {
        mutations.push(`disable:${body.variables?.input?.pullRequestId}`);
        return Response.json({ errors: [{ message: 'Auto-merge was not enabled' }] });
      }
      if (url.pathname.endsWith('/reviews')) return Response.json({ id: 1 });
      return Response.json({ message: `unexpected ${method} ${url.pathname}` }, { status: 500 });
    }) as typeof fetch;
    const app = {
      activeUserAccountId: () => 'owner-account',
      repositoryPermission: async (_user: string, slug: string) => ({ slug, permission: 'write', canMerge: true }),
      userAccessToken: async () => 'owner-token',
    };
    const core = await coreFor({ options: { apiBase: 'https://api.github.test', fetch: fetcher } }, app);
    (await core.store.claimPersonalOrganization('owner'));
    const project = (await core.store.createProject('Participant landing', { landingAuthority: 'auto' }));
    const task = (await core.store.createTask({ projectId: project.id, title: 'Land both', workflow: 'software-dev',
      workflowVersion: '1.21.0', params: { prompt: 'x' }, createdBy: { kind: 'user', userId: 'owner' } }));
    const refs: TaskPullRequest[] = [51, 52].map((number) => ({ repo: `service-${number}`, slug: slugFor(number), number,
      nodeId: `PR_${number}`, url: `https://github.test/${slugFor(number)}/pull/${number}`,
      state: 'open', headSha: headFor(number) }));
    (await core.store.appendEvent({ taskId: task.id, type: 'task.confirmation-voted', ts: 1, payload: {
      userId: 'owner', satisfied: true, githubMergeIntentAuthorized: true,
      githubPrHeads: refs.map(({ slug, number, headSha }) => ({ slug, number, headSha })),
    } }));

    const failed = await core.mergeGithubPrs({ id: task.id } as any, refs, { mode: 'preflight', authority: 'auto' });
    expect(failed).toMatchObject({ status: 'needs-revision', repair: { kind: 'ci' } });
    expect(mutations).toEqual([]);

    secondFails = false;
    const planned = await core.mergeGithubPrs({ id: task.id } as any, refs, { mode: 'preflight', authority: 'auto' });
    expect(planned).toMatchObject({
      status: 'planned',
      participants: [
        { key: 'acme/service-a#51', owner: 'unowned', domain: 'github:acme/service-a:main' },
        { key: 'acme/service-b#52', owner: 'unowned', domain: 'github:acme/service-b:main' },
      ],
    });
    expect(planned.observationKey).toEqual(expect.any(String));
    checksPending = true;
    const waiting = await core.mergeGithubPrs({ id: task.id } as any, refs, { mode: 'preflight', authority: 'auto' });
    expect(waiting.status).toBe('planned');
    expect(waiting.observationKey).not.toBe(planned.observationKey);
    checksPending = false;
    const claimedA = await core.mergeGithubPrs({ id: task.id } as any, [refs[0]!], { mode: 'claim-provider', authority: 'auto' });
    const claimedB = await core.mergeGithubPrs({ id: task.id } as any, [refs[1]!], { mode: 'claim-provider', authority: 'auto' });
    expect(claimedA).toMatchObject({ status: 'queued', landingOwner: 'provider', participants: [{ owner: 'provider' }] });
    expect(claimedB).toMatchObject({ status: 'waiting', landingOwner: 'karmax',
      participants: [{ owner: 'karmax', domain: 'github:acme/service-b:main' }] });
    expect(mutations).toEqual(['enqueue:PR_51', 'enqueue:PR_52', 'auto:PR_52']);

    const withdrawn = await core.withdrawGithubPrs({ id: task.id } as any, [refs[0]!], 'owner');
    expect(withdrawn).toMatchObject({ withdrawn: ['acme/service-a#51'], failed: {}, reconciled: [refs[0]] });
    expect(mutations.slice(-2)).toEqual(['dequeue:PR_51', 'disable:PR_51']);
  });

  it('v1.21 fails closed before publication when a changed PR-policy checkout has no GitHub target', async () => {
    const gh = fakeGithub();
    const core = await coreFor(gh, {
      activeUserAccountId: () => 'owner-account',
      status: () => ({ userAuthorized: true, oauthConfigured: true }),
      userAccessToken: async () => 'owner-token',
    });
    const githubRepo = await repoWithGithubOrigin('hybrid-github', 'acme/hybrid');
    const localRepo = path.join(tmp, 'hybrid-local');
    fs.mkdirSync(localRepo, { recursive: true });
    await gitOrThrow(localRepo, ['init', '-q', '-b', 'main']);
    await ensureIdentity(localRepo);
    fs.writeFileSync(path.join(localRepo, 'base.txt'), 'base\n');
    await git(localRepo, ['add', '-A']);
    await git(localRepo, ['commit', '-q', '-m', 'init']);
    (await core.store.claimPersonalOrganization('owner'));
    const project = (await core.store.createProject('Hybrid fail closed', { repos: [githubRepo, localRepo], remote: 'pr' }));
    const connection = (await core.store.upsertGitConnection({ organizationId: project.organizationId!, provider: 'github',
      installationId: 'hybrid-installation', accountLogin: 'acme', accountType: 'Organization' }));
    const enrolled = (await core.store.upsertRepository({ organizationId: project.organizationId!, provider: 'github',
      providerId: 'hybrid-repo', owner: 'acme', name: 'hybrid', sshUrl: 'git@github.com:acme/hybrid.git',
      defaultBranch: 'main', private: true, gitConnectionId: connection.id }));
    (await core.store.attachProjectRepository({ projectId: project.id, repositoryId: enrolled.id }));
    const task = (await core.store.createTask({ projectId: project.id, title: 'Hybrid', workflow: 'software-dev',
      workflowVersion: '1.21.0', params: { prompt: 'x' }, createdBy: { kind: 'user', userId: 'owner' } }));
    const handle = await core.createWorld({ taskId: task.id, projectId: project.id, repos: [githubRepo, localRepo],
      base: 'main', target: 'main', kind: 'worktree' });
    for (const repo of handle.repos!.filter((candidate: any) => candidate.role !== 'project-wiki')) {
      fs.writeFileSync(path.join(repo.root, 'change.txt'), `${repo.name}\n`);
      await git(repo.root, ['add', '-A']);
      await git(repo.root, ['commit', '-q', '-m', 'change']);
    }

    await expect(core.openPr(handle, 'main', { title: 'Hybrid' })).rejects.toThrow(/changed checkout.*no GitHub PR target/i);
    expect(gh.prs).toHaveLength(0);
    await core.destroyWorld(handle);
  });

  it('separates transient GitHub outages from authorization failures', async () => {
    let status = 503;
    let message = 'Service unavailable';
    const fetcher = (async () => Response.json({ message }, { status })) as typeof fetch;
    const app = {
      activeUserAccountId: () => 'owner-account',
      repositoryPermission: async () => ({ slug: SLUG, permission: 'write', canMerge: true }),
      userAccessToken: async () => 'owner-token',
    };
    const core = await coreFor({ options: { apiBase: 'https://api.github.test', fetch: fetcher } }, app);
    (await core.store.claimPersonalOrganization('owner'));
    const project = (await core.store.createProject('GitHub error classification'));
    const task = (await core.store.createTask({ projectId: project.id, title: 'Retry me', workflow: 'software-dev',
      workflowVersion: '1.14.0', params: { prompt: 'x' }, createdBy: { kind: 'user', userId: 'owner' } }));
    const ref = { repo: 'widgets', slug: SLUG, number: 22, url: 'https://github.test/acme/widgets/pull/22',
      state: 'open', headSha: 'reviewed-head' } as TaskPullRequest;
    const handle = { id: task.id, kind: 'worktree', branch: 'tavya/task_error', base: 'main', repo: tmp, root: tmp } as any;

    await expect(core.mergeGithubPrs(handle, [ref])).resolves.toMatchObject({ status: 'retryable-error', detail: expect.stringMatching(/503/) });
    status = 401;
    message = 'Bad credentials';
    await expect(core.mergeGithubPrs(handle, [ref])).resolves.toMatchObject({ status: 'needs-authorizer', detail: expect.stringMatching(/reconnect GitHub/i) });
    status = 403;
    message = 'API rate limit exceeded';
    await expect(core.mergeGithubPrs(handle, [ref])).resolves.toMatchObject({ status: 'retryable-error', detail: expect.stringMatching(/rate limit/i) });
  });

  it('binds merge-queue and auto-merge fallback to the reviewed head', async () => {
    const graphqlInputs: any[] = [];
    const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const method = init.method ?? 'GET';
      if (method === 'GET') return Response.json({
        number: 8, node_id: 'PR_auto', html_url: 'https://github.test/acme/widgets/pull/8', state: 'open',
        merged: false, head: { ref: 'tavya/task_auto', sha: 'exact-head' }, base: { ref: 'main' },
      });
      if (method === 'PUT') return Response.json({ merged: false, message: 'Required checks are pending' }, { status: 409 });
      const body = JSON.parse(String(init.body));
      if (body.variables?.input) graphqlInputs.push(body.variables.input);
      if (String(body.query).includes('enqueuePullRequest'))
        return Response.json({ errors: [{ message: 'This branch has no merge queue' }] });
      return Response.json({ data: { enablePullRequestAutoMerge: { pullRequest: {
        id: 'PR_auto', autoMergeRequest: { enabledAt: '2026-08-03T00:00:00Z', mergeMethod: 'SQUASH' },
      } } } });
    }) as typeof fetch;
    const app = {
      activeUserAccountId: () => 'owner-account',
      repositoryPermission: async () => ({ slug: SLUG, permission: 'write', canMerge: true, mergeMethod: 'squash' }),
      userAccessToken: async () => 'owner-token',
    };
    const core = await coreFor({ options: { apiBase: 'https://api.github.test', fetch: fetcher } }, app);
    (await core.store.claimPersonalOrganization('owner'));
    const project = (await core.store.createProject('Auto merge'));
    const task = (await core.store.createTask({ projectId: project.id, title: 'Auto merge me', workflow: 'software-dev',
      workflowVersion: '1.12.0', params: { prompt: 'x', _githubAccountId: 'owner-account' },
      createdBy: { kind: 'user', userId: 'owner' } }));
    await expect(core.mergeGithubPrs({ id: task.id, kind: 'worktree', branch: 'tavya/task_auto',
      base: 'main', repo: tmp, root: tmp } as any, [{ repo: 'widgets', slug: SLUG, number: 8,
      url: 'https://github.test/acme/widgets/pull/8', state: 'open', headSha: 'exact-head' }]))
      .resolves.toMatchObject({ status: 'queued', detail: expect.stringMatching(/auto-merge/) });
    expect(graphqlInputs).toEqual([
      { pullRequestId: 'PR_auto', expectedHeadOid: 'exact-head' },
      { pullRequestId: 'PR_auto', expectedHeadOid: 'exact-head', mergeMethod: 'SQUASH' },
    ]);
  });
});

/** A repository where freshness is observable: every commit knows its
 *  ancestors, and merges and branch updates create real descendants. No branch
 *  has strict protection, so GitHub never reports BEHIND (GH-26). */
function freshnessGithub(branches: Record<string, string>) {
  const ancestry = new Map<string, Set<string>>(Object.values(branches).map((sha) => [sha, new Set([sha])]));
  const prs = new Map<number, { head: string; ref: string; base: string; merged?: string }>();
  const checks = new Map<string, string>();
  const calls: string[] = [];
  const outage = { readiness: undefined as string | undefined };
  const commit = (sha: string, ...parents: string[]) => {
    ancestry.set(sha, new Set([sha, ...parents.flatMap((parent) => [...ancestry.get(parent)!])]));
    return sha;
  };
  const contains = (head: string, sha: string) => ancestry.get(head)!.has(sha);
  const behindBy = (head: string, base: string) => [...ancestry.get(base)!].filter((sha) => !contains(head, sha)).length;
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : {};
    calls.push(`${method} ${decodeURIComponent(url.pathname)}`);
    const compare = decodeURIComponent(url.pathname).match(/\/compare\/(.+)\.\.\.(.+)$/);
    if (compare) {
      const base = branches[compare[1]!] ?? compare[1]!;
      return Response.json({ status: 'diverged', base_commit: { sha: base },
        ahead_by: behindBy(base, compare[2]!), behind_by: behindBy(compare[2]!, base) });
    }
    const number = Number(url.pathname.match(/\/pulls\/(\d+)/)?.[1] ?? body.variables?.number);
    const pr = prs.get(number)!;
    const view = () => ({ number, node_id: `PR_${number}`, html_url: `https://github.test/${SLUG}/pull/${number}`,
      state: pr.merged ? 'closed' : 'open', merged: Boolean(pr.merged), ...(pr.merged ? { merge_commit_sha: pr.merged } : {}),
      head: { ref: pr.ref, sha: pr.head }, base: { ref: pr.base } });
    if (method === 'GET' && url.pathname.endsWith(`/pulls/${number}`)) return Response.json(view());
    if (url.pathname === '/graphql' && String(body.query).includes('PullRequestReadiness')) {
      if (outage.readiness) return Response.json({ errors: [{ message: outage.readiness }] });
      const state = checks.get(pr.head) ?? 'PENDING';
      return Response.json({ data: { repository: { pullRequest: {
        id: `PR_${number}`, url: view().html_url, state: pr.merged ? 'MERGED' : 'OPEN', isDraft: false,
        merged: Boolean(pr.merged), headRefOid: pr.head, baseRefOid: branches[pr.base], mergeable: 'MERGEABLE',
        mergeStateStatus: state === 'SUCCESS' ? 'CLEAN' : 'UNSTABLE',
        statusCheckRollup: { state, contexts: { nodes: [] } },
        viewerCanEnableAutoMerge: false, viewerCanMergeAsAdmin: false,
      } } } });
    }
    if (method === 'PUT' && url.pathname.endsWith('/update-branch')) {
      expect(body).toEqual({ expected_head_sha: pr.head });
      pr.head = commit(`${pr.head}+${branches[pr.base]}`, pr.head, branches[pr.base]!);
      return Response.json({ message: 'Updating pull request branch.' }, { status: 202 });
    }
    if (method === 'PUT' && url.pathname.endsWith('/merge')) {
      expect(body.sha).toBe(pr.head);
      pr.merged = branches[pr.base] = commit(`merge-${number}`, branches[pr.base]!, pr.head);
      return Response.json({ merged: true, sha: pr.merged, message: 'Pull Request successfully merged' });
    }
    return Response.json({ message: `unrouted ${method} ${url.pathname}` }, { status: 404 });
  }) as typeof fetch;
  return { fetcher, branches, prs, checks, calls, commit, outage,
    options: { apiBase: 'https://api.github.test', fetch: fetcher } };
}

async function freshnessCore(github: ReturnType<typeof freshnessGithub>) {
  const core = await coreFor(github, {
    activeUserAccountId: () => 'reviewer-account',
    repositoryPermission: async () => ({ slug: SLUG, permission: 'write', canMerge: true }),
    userAccessToken: async () => 'reviewer-token',
  });
  (await core.store.claimPersonalOrganization('owner'));
  const project = (await core.store.createProject('Sub-task landing', { landingAuthority: 'auto' }));
  (await core.store.setOrganizationMembership(project.organizationId!, 'reviewer', 'member'));
  (await core.store.setProjectMembership(project.id, { kind: 'user', userId: 'reviewer' }, 'reviewer'));
  const parent = (await core.store.createTask({ projectId: project.id, title: 'Parent', workflow: 'software-dev',
    workflowVersion: '1.24.0', params: { prompt: 'x' }, createdBy: { kind: 'user', userId: 'owner' } }));
  (await core.store.registerWorld({ id: parent.id, kind: 'worktree', branch: 'karmax/task_parent',
    base: 'main', repo: tmp, root: tmp } as any, project.id));
  /** A confirmed task with one open PR, landed the way fallback admission does. */
  const confirmed = async (number: number, head: string, base: string, parentTaskId?: string) => {
    const task = (await core.store.createTask({ projectId: project.id, title: `PR ${number}`, workflow: 'software-dev',
      workflowVersion: '1.24.0', params: { prompt: 'x', base, target: base },
      createdBy: { kind: 'user', userId: 'owner' }, ...(parentTaskId ? { parentTaskId } : {}) }));
    (await core.store.appendEvent({ taskId: task.id, type: 'task.confirmation-voted', ts: 1, payload: {
      userId: 'reviewer', satisfied: true, githubMergeAuthorized: true, githubMergeIntentAuthorized: true,
      githubPrHeads: [{ slug: SLUG, number, headSha: head }],
    } }));
    github.prs.set(number, { head, ref: `karmax/${task.id}`, base });
    const handle = { id: task.id, kind: 'worktree', branch: `karmax/${task.id}`, base, repo: tmp, root: tmp } as any;
    let prs: TaskPullRequest[] = [{ repo: 'widgets', slug: SLUG, number, nodeId: `PR_${number}`,
      url: `https://github.test/${SLUG}/pull/${number}`, state: 'open', headSha: head }];
    return {
      task,
      land: async () => {
        const result = await core.mergeGithubPrs(handle, prs, { mode: 'submit-fallback', authority: 'karmax' });
        prs = result.prs;
        return result;
      },
    };
  };
  return { core, parent, confirmed };
}

describe('Fallback landing readiness (task 450)', () => {
  it('reports a failed readiness read as a GitHub error, not as GitHub still computing', async () => {
    const github = freshnessGithub({ main: 'main-0' });
    github.checks.set(github.commit('reviewed-head', 'main-0'), 'SUCCESS');
    const { confirmed } = await freshnessCore(github);
    const proposal = await confirmed(1, 'reviewed-head', 'main');

    github.outage.readiness = 'Something went wrong while executing your query';
    const failed = await proposal.land();
    expect(failed).toMatchObject({ status: 'retryable-error',
      detail: expect.stringMatching(/could not be inspected.*Something went wrong/) });
    expect(failed.detail).not.toMatch(/still computing/);
    expect(github.calls).not.toContain('PUT /repos/acme/widgets/pulls/1/merge');

    github.outage.readiness = undefined;
    await expect(proposal.land()).resolves.toMatchObject({ status: 'merged' });
  });
});

describe('Sub-task landing freshness (GH-26)', () => {
  it('updates a green sibling that lacks the parent branch head and waits for its fresh checks', async () => {
    const github = freshnessGithub({ 'karmax/task_parent': 'parent-0' });
    github.checks.set(github.commit('first-head', 'parent-0'), 'SUCCESS');
    github.checks.set(github.commit('second-head', 'parent-0'), 'SUCCESS');
    const { core, parent, confirmed } = await freshnessCore(github);
    const first = await confirmed(1, 'first-head', 'karmax/task_parent', parent.id);
    const second = await confirmed(2, 'second-head', 'karmax/task_parent', parent.id);

    await expect(first.land()).resolves.toMatchObject({ status: 'merged' });
    expect(github.branches['karmax/task_parent']).toBe('merge-1');

    // GitHub still calls the second PR CLEAN: its green CI never saw merge-1.
    await expect(second.land()).resolves.toMatchObject({
      status: 'waiting', landingOwner: 'karmax',
      prs: [expect.objectContaining({ headSha: 'second-head+merge-1' })],
      detail: expect.stringMatching(/mechanically updated/),
    });
    expect(github.calls).not.toContain('PUT /repos/acme/widgets/pulls/2/merge');
    await expect(second.land()).resolves.toMatchObject({
      status: 'waiting', detail: expect.stringMatching(/waiting for required checks/),
    });
    expect(github.prs.get(2)?.merged).toBeUndefined();

    github.checks.set('second-head+merge-1', 'SUCCESS');
    await expect(second.land()).resolves.toMatchObject({ status: 'merged' });
    expect(github.calls.filter((call) => call.endsWith('/update-branch'))).toEqual(['PUT /repos/acme/widgets/pulls/2/update-branch']);
    expect((await core.store.eventsOfTypes(second.task.id, ['github.pr.merged'])).map((event) => event.payload))
      .toEqual([expect.objectContaining({ number: 2, sha: 'merge-2', strategy: 'provider-policy' })]);
    expect(github.branches['karmax/task_parent']).toBe('merge-2');
  });

  it('merges a sibling whose head already contains the parent branch head without updating it', async () => {
    const github = freshnessGithub({ 'karmax/task_parent': 'parent-0' });
    github.branches['karmax/task_parent'] = github.commit('parent-1', 'parent-0');
    github.checks.set(github.commit('fresh-head', 'parent-1'), 'SUCCESS');
    const { parent, confirmed } = await freshnessCore(github);
    const sibling = await confirmed(1, 'fresh-head', 'karmax/task_parent', parent.id);

    await expect(sibling.land()).resolves.toMatchObject({ status: 'merged' });
    expect(github.calls).toContain('GET /repos/acme/widgets/compare/karmax/task_parent...fresh-head');
    expect(github.calls.some((call) => call.endsWith('/update-branch'))).toBe(false);
    expect(github.branches['karmax/task_parent']).toBe('merge-1');
  });

  it("keeps GitHub's policy authoritative for a target that is not the parent's task branch", async () => {
    const github = freshnessGithub({ main: 'main-0', 'karmax/task_parent': 'parent-0' });
    github.branches.main = github.commit('main-1', 'main-0');
    github.checks.set(github.commit('stale-head', 'main-0'), 'SUCCESS');
    github.checks.set(github.commit('stale-child-head', 'main-0'), 'SUCCESS');
    const { parent, confirmed } = await freshnessCore(github);
    // A top-level task, and a sub-task whose PR targets another branch than its parent's.
    const topLevel = await confirmed(1, 'stale-head', 'main');
    const elsewhere = await confirmed(2, 'stale-child-head', 'main', parent.id);

    await expect(topLevel.land()).resolves.toMatchObject({ status: 'merged' });
    await expect(elsewhere.land()).resolves.toMatchObject({ status: 'merged' });
    expect(github.calls.some((call) => call.includes('/compare/') || call.endsWith('/update-branch'))).toBe(false);
  });
});

describe('PR stage (remote policy "pr")', () => {
  it('pushes the task branch and opens a PR carrying the task summary', async () => {
    const gh = fakeGithub();
    const core = await coreFor(gh);
    const repo = await repoWithGithubOrigin('svc');
    const handle = await core.createWorld({ taskId: 'task_pr1', repo, base: 'main', target: 'main', kind: 'worktree' });
    await fs.promises.writeFile(path.join(handle.root, 'feature.txt'), 'x');
    await git(handle.root, ['add', '-A']);
    await git(handle.root, ['commit', '-q', '-m', 'work']);

    const opened = await core.openPr(handle, 'main', { title: 'Add a feature', summary: 'Adds feature.txt.' });
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ repo: 'svc', slug: SLUG, number: 1, state: 'open' });
    expect(gh.prs[0].title).toBe('Add a feature');
    expect(gh.prs[0].body).toContain('Adds feature.txt.');
    expect(gh.prs[0].body).toContain('task_pr1'); // provenance back to karmax
    expect(gh.prs[0].head.ref).toBe(handle.branch);
    expect(gh.prs[0].base.ref).toBe('main');
    // The branch really reached origin — a PR that references nothing is useless.
    const origin = path.join(tmp, 'svc-origin.git');
    expect((await git(origin, ['rev-parse', '--verify', handle.branch])).code).toBe(0);

    // Re-running the stage (retry, or a follow-up that reopened Do) updates it.
    const again = await core.openPr(handle, 'main', { title: 'Add a feature v2', summary: 'More.' });
    expect(again[0]!.number).toBe(1);
    expect(gh.prs).toHaveLength(1);
    expect(gh.prs[0].title).toBe('Add a feature v2');
    await core.openPr(handle, 'main', { summary: '😀'.repeat(70_000) });
    expect(Buffer.byteLength(gh.prs[0].body, 'utf8')).toBeLessThanOrEqual(65_536);
    expect(gh.prs[0].body).toContain('task_pr1');
    expect(gh.prs[0].body).not.toContain('\uFFFD');
    await core.destroyWorld(handle);
  });

  it('compares against origin when a restored checkout lacks a local PR target branch', async () => {
    const gh = fakeGithub();
    const core = await coreFor(gh);
    const repo = await repoWithGithubOrigin('restored-target');
    const handle = await core.createWorld({
      taskId: 'task_pr_restored_target', repo, base: 'main', target: 'main', kind: 'worktree',
    });
    const checkout = handle.repos![0]!;
    await gitOrThrow(checkout.root, ['update-ref', 'refs/remotes/origin/release', 'main']);
    expect((await git(checkout.root, ['rev-parse', '--verify', 'release'])).code).not.toBe(0);
    expect((await git(checkout.root, ['rev-parse', '--verify', 'refs/remotes/origin/release'])).code).toBe(0);

    await expect(core.openPr(handle, 'release', { title: 'Unchanged restored target' })).resolves.toEqual([]);
    expect(gh.prs).toHaveLength(0);

    await fs.promises.writeFile(path.join(checkout.root, 'restored.txt'), 'changed');
    await git(checkout.root, ['add', '-A']);
    await git(checkout.root, ['commit', '-q', '-m', 'restored world work']);

    await expect(core.openPr(handle, 'release', { title: 'Restored target' })).resolves.toHaveLength(1);
    expect(gh.prs[0].base.ref).toBe('release');
    await core.destroyWorld(handle);
  });

  // Tasks 368–376 (2026-09-26): a sub-task's CI repair merged origin/<parent>,
  // fast-forwarding an untouched checkout to the parent's newer tip. The stale
  // local parent ref still counted those commits as "ahead", so krmax asked
  // GitHub for a PR with no commits and escalated on its 422.
  it('skips a checkout that only caught up with a newer remote target', async () => {
    const gh = fakeGithub();
    const core = await coreFor(gh);
    const repo = await repoWithGithubOrigin('caught-up');
    const handle = await core.createWorld({ taskId: 'task_pr_caught_up', repo, base: 'main', target: 'main', kind: 'worktree' });
    const checkout = handle.repos![0]!;
    // The target moves on origin after the world was created (another task landed).
    const upstream = path.join(tmp, 'caught-up-upstream');
    await gitOrThrow(tmp, ['clone', '-q', path.join(tmp, 'caught-up-origin.git'), upstream]);
    await ensureIdentity(upstream);
    fs.writeFileSync(path.join(upstream, 'landed.txt'), 'landed');
    await gitOrThrow(upstream, ['add', '-A']);
    await gitOrThrow(upstream, ['commit', '-q', '-m', 'landed elsewhere']);
    await gitOrThrow(upstream, ['push', '-q', 'origin', 'main']);
    // refresh_upstream + merge: the task branch now equals origin/main, while the
    // local `main` ref is still the old tip.
    await gitOrThrow(checkout.root, ['fetch', '-q', 'origin', 'main:refs/remotes/origin/main']);
    await gitOrThrow(checkout.root, ['merge', '-q', '--ff-only', 'refs/remotes/origin/main']);
    expect((await git(checkout.root, ['rev-list', '--count', `main..${checkout.branch}`])).stdout.trim()).toBe('1');

    await expect(core.openPr(handle, 'main', { title: 'Nothing of its own' })).resolves.toEqual([]);
    expect(gh.prs).toHaveLength(0);

    fs.writeFileSync(path.join(checkout.root, 'own.txt'), 'own');
    await git(checkout.root, ['add', '-A']);
    await git(checkout.root, ['commit', '-q', '-m', 'own work']);
    await expect(core.openPr(handle, 'main', { title: 'Own work' })).resolves.toHaveLength(1);
    await core.destroyWorld(handle);
  });

  it('does not propose commits the fetched target already has when the local target is stale', async () => {
    // refresh_upstream advances only origin/<target>; the world's local target
    // stays at its provisioning commit. A task that merged the refreshed target
    // has nothing of its own, and GitHub refuses that PR with 422 "No commits
    // between" — which escalated tasks 368, 369, 372 and 373.
    const gh = fakeGithub();
    const core = await coreFor(gh);
    const repo = await repoWithGithubOrigin('stale-local-target');
    const handle = await core.createWorld({
      taskId: 'task_pr_stale_target', repo, base: 'main', target: 'main', kind: 'worktree',
    });
    const checkout = handle.repos![0]!;
    const staleMain = (await gitOrThrow(checkout.root, ['rev-parse', 'main'])).trim();
    fs.writeFileSync(path.join(checkout.root, 'landed-elsewhere.txt'), 'already on the target');
    await gitOrThrow(checkout.root, ['add', '-A']);
    await gitOrThrow(checkout.root, ['commit', '-q', '-m', 'landed on the target by someone else']);
    await gitOrThrow(checkout.root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    expect((await gitOrThrow(checkout.root, ['rev-parse', 'main'])).trim()).toBe(staleMain);

    await expect(core.openPr(handle, 'main', { title: 'Nothing new' })).resolves.toEqual([]);
    expect(gh.prs).toHaveLength(0);

    fs.writeFileSync(path.join(checkout.root, 'own.txt'), 'the task\'s own change');
    await gitOrThrow(checkout.root, ['add', '-A']);
    await gitOrThrow(checkout.root, ['commit', '-q', '-m', 'task work']);
    await expect(core.openPr(handle, 'main', { title: 'Own change' })).resolves.toHaveLength(1);
    await core.destroyWorld(handle);
  });

  it('skips a checkout GitHub reports has no commits between its branch and the target', async () => {
    const gh = fakeGithub();
    const fetcher = gh.options.fetch;
    gh.options.fetch = (async (url: string, init: RequestInit = {}) => {
      if ((init.method ?? 'GET') === 'POST' && /\/pulls$/.test(new URL(String(url)).pathname))
        return Response.json({ message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom',
          message: 'No commits between main and karmax/task_pr_github_empty' }] }, { status: 422 });
      return fetcher(url, init);
    }) as typeof fetch;
    const core = await coreFor(gh);
    const repo = await repoWithGithubOrigin('github-empty');
    const handle = await core.createWorld({
      taskId: 'task_pr_github_empty', repo, base: 'main', target: 'main', kind: 'worktree',
    });
    const checkout = handle.repos![0]!;
    fs.writeFileSync(path.join(checkout.root, 'work.txt'), 'already landed upstream');
    await gitOrThrow(checkout.root, ['add', '-A']);
    await gitOrThrow(checkout.root, ['commit', '-q', '-m', 'work GitHub already has']);

    await expect(core.openPr(handle, 'main', { title: 'Empty on GitHub' })).resolves.toEqual([]);
    expect((await core.store.eventsSince(handle.id, 0)).filter((event) => event.type === 'pr.skipped'))
      .toEqual([expect.objectContaining({ payload: expect.objectContaining({ repo: checkout.name }) })]);
    await core.destroyWorld(handle);
  });

  it('compares against the recorded base when a dynamically enrolled checkout has no target refs', async () => {
    const gh = fakeGithub();
    const core = await coreFor(gh);
    const repo = await repoWithGithubOrigin('bundle-only-target');
    const handle = await core.createWorld({
      taskId: 'task_pr_bundle_only_target', repo, base: 'main', target: 'main', kind: 'worktree',
    });
    const checkout = handle.repos![0]!;
    checkout.baseSha = (await gitOrThrow(checkout.root, ['rev-parse', 'main'])).trim();
    expect((await git(checkout.root, ['rev-parse', '--verify', 'release'])).code).not.toBe(0);
    expect((await git(checkout.root, ['rev-parse', '--verify', 'refs/remotes/origin/release'])).code).not.toBe(0);

    await expect(core.openPr(handle, 'release', { title: 'Unchanged bundle checkout' })).resolves.toEqual([]);
    expect(gh.prs).toHaveLength(0);

    await fs.promises.writeFile(path.join(checkout.root, 'bundle.txt'), 'changed');
    await git(checkout.root, ['add', '-A']);
    await git(checkout.root, ['commit', '-q', '-m', 'bundle-only world work']);

    await expect(core.openPr(handle, 'release', { title: 'Bundle-only target' })).resolves.toHaveLength(1);
    expect(gh.prs[0].base.ref).toBe('release');
    await core.destroyWorld(handle);
  });

  it('uses one connected GitHub account for user-attributed PRs and App-authenticated pushes', async () => {
    const gh = fakeGithub();
    const repo = await repoWithGithubOrigin('connected');
    const userTokenCalls: Array<boolean | undefined> = [];
    const transport: string[] = [];
    const core = await coreFor(gh, {
      status(userId: string) {
        expect(userId).toBe('jane');
        return { configured: true, oauthConfigured: true, userAuthorized: true };
      },
      async userAccessToken(userId: string, options?: { forceRefresh?: boolean }) {
        expect(userId).toBe('jane');
        userTokenCalls.push(options?.forceRefresh);
        return 'connected-user-token';
      },
      async brokerCredentials(repository: { name: string }) {
        transport.push(repository.name);
        return { httpsToken: 'installation-token', env: { GH_TOKEN: 'installation-token' } };
      },
      async repositoryCloneToken() { return 'clone-token'; },
    });
    (await core.store.claimPersonalOrganization('jane'));
    const project = (await core.store.createProject('Connected', { repos: [repo] }));
    const connection = (await core.store.upsertGitConnection({ organizationId: project.organizationId!, provider: 'github',
      installationId: '42', accountLogin: 'acme', accountType: 'Organization' }));
    const enrolled = (await core.store.upsertRepository({ organizationId: project.organizationId!, provider: 'github',
      providerId: '77', owner: 'acme', name: 'widgets', sshUrl: REMOTE, defaultBranch: 'main', private: true,
      gitConnectionId: connection.id }));
    (await core.store.attachProjectRepository({ projectId: project.id, repositoryId: enrolled.id }));
    const task = (await core.store.createTask({ projectId: project.id, title: 'Connected PR', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'work' }, createdBy: { kind: 'user', userId: 'jane' } }));

    const handle = await core.createWorld({ taskId: task.id, projectId: project.id, repo,
      base: 'main', target: 'main', kind: 'worktree' });
    await fs.promises.writeFile(path.join(handle.workdir ?? handle.root, 'connected.txt'), 'x');
    await git(handle.workdir ?? handle.root, ['add', '-A']);
    await git(handle.workdir ?? handle.root, ['commit', '-q', '-m', 'connected work']);

    await expect(core.openPr(handle, 'main', { title: 'Connected PR' })).resolves.toHaveLength(1);
    expect(gh.tokens).toContain('Bearer connected-user-token');
    expect(userTokenCalls).toContain(undefined);
    expect(transport).toContain('widgets');
    expect((await git(path.join(tmp, 'connected-origin.git'), ['rev-parse', '--verify', handle.branch])).code).toBe(0);
    await expect(core.finalizeMergeActivity(handle, 'main')).resolves.toMatchObject({ merged: true });
    const targetPush = await core.pushTarget(handle, 'main');
    expect(targetPush.pushed).toContain('connected');
    expect(transport.filter((name) => name === 'widgets')).toHaveLength(2);
    expect((await git(path.join(tmp, 'connected-origin.git'), ['show', 'main:connected.txt'])).stdout).toBe('x');
    await core.destroyWorld(handle);
  });

  it('identifies a genuinely missing human GitHub PR connection before transport', async () => {
    const gh = fakeGithub();
    const repo = await repoWithGithubOrigin('missing-human');
    const transport = vi.fn(async () => ({ env: {} }));
    const core = await coreFor(gh, {
      status: () => ({ configured: true, oauthConfigured: true, userAuthorized: false,
        lastAuthorizationFailure: {
          code: 'refresh_rejected',
          summary: 'GitHub rejected the refresh token (bad_refresh_token). Reconnect GitHub.',
          occurredAt: Date.parse('2026-08-17T06:30:00.000Z'),
          disconnected: true,
          providerError: 'bad_refresh_token',
        } }),
      activeUserAccountId: () => undefined,
      repositoryCloneToken: async () => 'clone-token',
      brokerCredentials: transport,
    });
    (await core.store.claimPersonalOrganization('jane'));
    const project = (await core.store.createProject('Missing human identity', { repos: [repo] }));
    const connection = (await core.store.upsertGitConnection({ organizationId: project.organizationId!, provider: 'github',
      installationId: '42', accountLogin: 'acme', accountType: 'Organization' }));
    const enrolled = (await core.store.upsertRepository({ organizationId: project.organizationId!, provider: 'github',
      providerId: '77', owner: 'acme', name: 'widgets', sshUrl: REMOTE, defaultBranch: 'main', private: true,
      gitConnectionId: connection.id }));
    (await core.store.attachProjectRepository({ projectId: project.id, repositoryId: enrolled.id }));
    const task = (await core.store.createTask({ projectId: project.id, title: 'Missing identity', workflow: 'software-dev',
      workflowVersion: '1.26.0', params: { prompt: 'work' }, createdBy: { kind: 'user', userId: 'jane' } }));
    const handle = await core.createWorld({ taskId: task.id, projectId: project.id, repo,
      base: 'main', target: 'main', kind: 'worktree' });
    await fs.promises.writeFile(path.join(handle.root, 'change.txt'), 'x');
    await git(handle.root, ['add', '-A']);
    await git(handle.root, ['commit', '-q', '-m', 'change']);

    await expect(core.openPr(handle, 'main', {})).rejects.toThrow(
      /GitHub PR identity is not connected.*Last recorded authorization failure:.*bad_refresh_token.*2026-08-17T06:30:00\.000Z.*not a non-fast-forward or local ancestry error/i,
    );
    expect(transport).not.toHaveBeenCalled();
    await core.destroyWorld(handle);
  });

  it('uses the connected account for a configured local origin without a project attachment', async () => {
    const gh = fakeGithub();
    const repo = await repoWithGithubOrigin('connected-local');
    const core = await coreFor(gh, {
      status() { return { configured: true, oauthConfigured: true, userAuthorized: true }; },
      activeUserAccountId() { return '77'; },
      async userAccessToken(userId: string, options?: { accountId?: string }) {
        expect(userId).toBe('jane');
        expect(options?.accountId).toBe('77');
        return 'connected-local-user-token';
      },
      async brokerCredentials() {
        return { httpsToken: 'installation-token', env: { GH_TOKEN: 'installation-token' } };
      },
    });
    (await core.store.claimPersonalOrganization('jane'));
    const project = (await core.store.createProject('Connected local', { repos: [repo] }));
    const connection = (await core.store.upsertGitConnection({ organizationId: project.organizationId!, provider: 'github',
      installationId: '42', accountLogin: 'acme', accountType: 'Organization' }));
    (await core.store.upsertRepository({ organizationId: project.organizationId!, provider: 'github',
      providerId: '77', owner: 'acme', name: 'widgets', sshUrl: REMOTE, defaultBranch: 'main', private: true,
      gitConnectionId: connection.id }));
    expect((await core.store.listProjectRepositories(project.id))).toHaveLength(0);
    const task = (await core.store.createTask({ projectId: project.id, title: 'Connected local PR', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'work' }, createdBy: { kind: 'user', userId: 'jane' } }));

    const handle = await core.createWorld({ taskId: task.id, projectId: project.id, repo,
      base: 'main', target: 'main', kind: 'worktree' });
    await fs.promises.writeFile(path.join(handle.workdir ?? handle.root, 'connected-local.txt'), 'x');
    await git(handle.workdir ?? handle.root, ['add', '-A']);
    await git(handle.workdir ?? handle.root, ['commit', '-q', '-m', 'connected local work']);

    await expect(core.openPr(handle, 'main', { title: 'Connected local PR' })).resolves.toHaveLength(1);
    expect(gh.tokens).toContain('Bearer connected-local-user-token');
    await core.destroyWorld(handle);
  });

  it('opens PRs only for changed checkouts and skips an unchanged companion wiki', async () => {
    const gh = fakeGithub();
    const core = await coreFor(gh);
    const app = await repoWithGithubOrigin('changed-app');
    const wiki = await repoWithGithubOrigin('unchanged-wiki', 'acme/project-wiki');
    const handle = await core.createWorld({
      taskId: 'task_pr_changed_only',
      repos: [app, wiki],
      base: 'main',
      target: 'main',
      kind: 'worktree',
    });
    const appCheckout = handle.repos![0]!;
    const wikiCheckout = handle.repos![1]!;
    await fs.promises.writeFile(path.join(appCheckout.root, 'feature.txt'), 'changed');
    await git(appCheckout.root, ['add', '-A']);
    await git(appCheckout.root, ['commit', '-q', '-m', 'change app only']);

    const opened = await core.openPr(handle, 'main', { title: 'App-only change' });

    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ repo: appCheckout.name, slug: SLUG });
    expect(gh.prs).toHaveLength(1);
    expect(gh.prs[0].repo).toBe(SLUG);
    expect(gh.prs[0].title).toBe('App-only change');
    expect((await git(path.join(tmp, 'changed-app-origin.git'), ['rev-parse', '--verify', appCheckout.branch])).code).toBe(0);
    // The unchanged companion branch is not published merely because it shares
    // the task world; it has no proposal and therefore no PR.
    expect((await git(path.join(tmp, 'unchanged-wiki-origin.git'), ['rev-parse', '--verify', wikiCheckout.branch])).code).not.toBe(0);
    await core.destroyWorld(handle);
  });

  it('pushes a cloud PR for a configured local checkout when only its companion wiki is App-enrolled', async () => {
    const gh = fakeGithub();
    const app = await repoWithGithubOrigin('local-app');
    await gitOrThrow(app, ['config', '--unset-all', `url.${path.join(tmp, 'local-app-origin.git')}.insteadOf`]);
    const content = path.join(tmp, 'content');
    const wikiRemote = 'git@github.com:acme/project-wiki.git';
    const wikiOrigin = path.join(tmp, 'wiki-origin.git');
    const credentialRequests: string[] = [];
    const core = await remoteCoreFor(gh, {
      async repositoryCloneToken() { return 'clone-token'; },
      async brokerCredentials(repository: { name: string }) {
        credentialRequests.push(repository.name);
        return { env: {} };
      },
    }, content);
    (await core.store.claimPersonalOrganization('owner'));
    const project = (await core.store.createProject('Local source', { repos: [app], worldProvider: 'fake-remote' }));
    const wikiRoot = ensureProjectWikiRepository(content, project.id);
    await gitOrThrow(tmp, ['init', '-q', '--bare', '-b', 'main', wikiOrigin]);
    await gitOrThrow(wikiRoot, ['remote', 'add', 'origin', wikiRemote]);
    await gitOrThrow(wikiRoot, ['config', `url.${wikiOrigin}.insteadOf`, wikiRemote]);
    await gitOrThrow(wikiRoot, ['push', '-q', 'origin', 'main']);
    await gitOrThrow(wikiRoot, ['config', '--unset-all', `url.${wikiOrigin}.insteadOf`]);
    const wiki = (await core.store.upsertRepository({ organizationId: project.organizationId!, provider: 'github',
      owner: 'acme', name: 'project-wiki', sshUrl: wikiRemote, defaultBranch: 'main', private: true }));
    (await core.store.setProjectWikiRepository(project.id, wiki.id));
    const task = (await core.store.createTask({ projectId: project.id, title: 'Cloud PR', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'work' } }));
    const handle = await core.createWorld({ taskId: task.id, repo: app, base: 'main', target: 'main', kind: 'fake-remote' });
    for (const [index, repo] of handle.repos!.entries()) {
      await fs.promises.writeFile(path.join(repo.root, `change-${index}.txt`), 'x');
      await git(repo.root, ['add', '-A']);
      await git(repo.root, ['commit', '-q', '-m', 'work']);
    }

    const prior = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('GIT_CONFIG_')));
    Object.assign(process.env, {
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: `url.${path.join(tmp, 'local-app-origin.git')}.insteadOf`, GIT_CONFIG_VALUE_0: REMOTE,
      GIT_CONFIG_KEY_1: `url.${wikiOrigin}.insteadOf`, GIT_CONFIG_VALUE_1: wikiRemote,
    });
    try {
      await expect(core.openPr(handle, 'main', { title: 'Cloud PR' })).resolves.toHaveLength(2);
      expect((await git(path.join(tmp, 'local-app-origin.git'), ['rev-parse', '--verify', handle.branch])).code).toBe(0);
      expect((await git(wikiOrigin, ['rev-parse', '--verify', handle.branch])).code).toBe(0);
      expect(credentialRequests).toEqual(['project-wiki']);
    } finally {
      for (const key of Object.keys(process.env).filter((key) => key.startsWith('GIT_CONFIG_'))) delete process.env[key];
      Object.assign(process.env, prior);
      await core.destroyWorld(handle);
    }
  });

  it('fails loudly when the policy asks for a PR and no repo has a GitHub origin', async () => {
    const gh = fakeGithub();
    const core = await coreFor(gh);
    const repo = path.join(tmp, 'local');
    fs.mkdirSync(repo, { recursive: true });
    await gitOrThrow(repo, ['init', '-q', '-b', 'main']);
    await ensureIdentity(repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-q', '-m', 'init']);
    const handle = await core.createWorld({ taskId: 'task_pr2', repo, base: 'main', target: 'main', kind: 'worktree' });
    await expect(core.openPr(handle, 'main', {})).rejects.toThrow(/GitHub origin/);
    await core.destroyWorld(handle);
  });

  /** Historical workflow pins can reach PR before their Merge agent has prepared
   *  a dirty branch. An empty proposal is not a PR-stage failure: skipping it lets
   *  that already-recorded workflow continue to Merge, whose dirty-worktree guard
   *  sends the work to the Merge agent instead of losing it. */
  it('skips an empty proposal so a historical workflow can continue to Merge', async () => {
    const gh = fakeGithub();
    const core = await coreFor(gh);
    const repo = await repoWithGithubOrigin('empty');
    const handle = await core.createWorld({ taskId: 'task_pr4', repo, base: 'main', target: 'main', kind: 'worktree' });
    // The agent wrote a file but never committed it — exactly the dirty-worktree case.
    await fs.promises.writeFile(path.join(handle.root, 'uncommitted.txt'), 'x');

    await expect(core.openPr(handle, 'main', {})).resolves.toEqual([]);
    expect(gh.prs).toHaveLength(0);
    // Neither a pointless GitHub request nor an empty remote branch is created.
    expect(gh.calls.filter((c) => c.startsWith('POST'))).toHaveLength(0);
    expect((await git(path.join(tmp, 'empty-origin.git'), ['rev-parse', '--verify', handle.branch])).code).not.toBe(0);
    // openPr is read-only in this case; Merge still sees the work it must classify.
    expect(fs.readFileSync(path.join(handle.root, 'uncommitted.txt'), 'utf8')).toBe('x');
    await core.destroyWorld(handle);
  });

  it('fails with an actionable message when no GitHub credential can act', async () => {
    const gh = fakeGithub();
    const core = await coreFor(gh);
    // An organization other than the migrated personal one never borrows the
    // host's login (PLAN-git-config §2.3), so with no profile there is no token.
    const org = (await core.store.createOrganization({ name: 'Acme' }));
    const project = (await core.store.createProject('Org project', {}, org.id));
    const repo = await repoWithGithubOrigin('nocred');
    const handle = await core.createWorld({ taskId: 'task_pr3', projectId: project.id, repo,
      base: 'main', target: 'main', kind: 'worktree' });
    await expect(core.openPr(handle, 'main', {})).rejects.toThrow(/GitHub identity\/authorization is missing for acme\/widgets.*not a branch-history conflict/i);
    await core.destroyWorld(handle);
  });
});

describe('PR lifecycle after the merge', () => {
  const ref = (over: Partial<TaskPullRequest> = {}): TaskPullRequest =>
    ({ repo: 'svc', slug: SLUG, number: 1, url: `https://github.com/${SLUG}/pull/1`, state: 'open', ...over });

  async function withOpenPr() {
    const gh = fakeGithub();
    const core = await coreFor(gh);
    const repo = await repoWithGithubOrigin('svc');
    const handle = await core.createWorld({ taskId: 'task_fin', repo, base: 'main', target: 'main', kind: 'worktree' });
    await fs.promises.writeFile(path.join(handle.root, 'f.txt'), 'x');
    await git(handle.root, ['add', '-A']);
    await git(handle.root, ['commit', '-q', '-m', 'work']);
    const prs = await core.openPr(handle, 'main', { title: 'T', summary: 'S' });
    return { gh, core, handle, prs };
  }

  it('RT-20 does not repeat finalization comments when the activity retries', async () => {
    const { gh, core, handle, prs } = await withOpenPr();
    try {
      const outcome = { target: 'main', sha: 'abc1234', pushed: ['svc'] };
      await core.finalizePrs(handle, prs, outcome);
      await core.finalizePrs(handle, prs, outcome);
      expect(gh.comments).toHaveLength(1);
    } finally { await core.destroyWorld(handle); }
  });

  it('RT-20 finds the accepted cancellation comment after its acknowledgement is lost', async () => {
    const { gh, core, handle, prs } = await withOpenPr();
    const original = GithubPrApi.prototype.comment;
    const comment = vi.spyOn(GithubPrApi.prototype, 'comment').mockImplementationOnce(async function(this: GithubPrApi, slug, number, body) {
      await original.call(this, slug, number, body);
      throw new Error('connection lost after comment');
    });
    try {
      await core.closePrs(handle, prs, 'cancelled');
      expect(gh.prs[0].state).toBe('open');
      await core.closePrs(handle, prs, 'cancelled');
      expect(gh.prs[0].state).toBe('closed');
      expect(gh.comments).toHaveLength(1);
    } finally { comment.mockRestore(); await core.destroyWorld(handle); }
  });

  it('records a PR GitHub already merged, and comments the tavya outcome', async () => {
    const { gh, core, handle, prs } = await withOpenPr();
    gh.prs[0].state = 'closed';
    gh.prs[0].merged_at = '2026-01-01T00:00:00Z';
    const settled = await core.finalizePrs(handle, prs, { target: 'main', sha: 'abc1234', pushed: ['svc'] });
    expect(settled[0]).toMatchObject({ number: 1, state: 'closed', merged: true });
    expect(gh.comments[0]!.body).toContain('Merged into `main` by tavya');
    expect(gh.comments[0]!.body).toContain('abc1234');
    await core.destroyWorld(handle);
  });

  it('closes a PR left open although the target was pushed', async () => {
    const { gh, core, handle, prs } = await withOpenPr();
    const settled = await core.finalizePrs(handle, prs, { target: 'main', sha: 'def5678', pushed: ['svc'] });
    expect(gh.prs[0].state).toBe('closed');
    expect(settled[0]!.state).toBe('closed');
    expect(gh.comments[0]!.body).toContain('Closing');
    await core.destroyWorld(handle);
  });

  /** Observed against real GitHub: the merge commit reaches the base branch, but
   *  GitHub has not finished marking the PR `merged` when karmax first reads it —
   *  and it does so moments later. The audit comment must describe the state the
   *  PR actually settled in, not the one karmax raced past. */
  it('reports the merge GitHub records only after the outcome is decided', async () => {
    const { gh, core, handle, prs } = await withOpenPr();
    let reads = 0;
    const lagging = await coreFor({ ...gh, options: { apiBase: 'https://api.github.test',
      fetch: (async (url: string, init: RequestInit = {}) => {
        const isRead = (init.method ?? 'GET') === 'GET' && /\/pulls\/\d+$/.test(new URL(String(url)).pathname);
        // GitHub notices the merge right after karmax's first look.
        if (isRead && reads++ === 1) { gh.prs[0].state = 'closed'; gh.prs[0].merged_at = '2026-01-01T00:00:00Z'; }
        return gh.fetcher(url as any, init);
      }) as unknown as typeof fetch } });
    const settled = await lagging.finalizePrs(handle, prs, { target: 'main', sha: 'cafe123', pushed: ['svc'] });
    expect(settled[0]).toMatchObject({ state: 'closed', merged: true });
    expect(gh.comments[0]!.body).toContain('Merged into `main` by tavya');
    expect(gh.comments[0]!.body).toContain('cafe123');
    expect(gh.comments[0]!.body).not.toContain('Closing');
    await core.destroyWorld(handle);
  });

  it('leaves the PR open, and says why, when the target never reached origin', async () => {
    const { gh, core, handle, prs } = await withOpenPr();
    const settled = await core.finalizePrs(handle, prs, { target: 'main', sha: 'aaa', pushed: [] });
    expect(gh.prs[0].state).toBe('open');
    expect(settled[0]!.state).toBe('open');
    expect(gh.comments[0]!.body).toContain('could not push');
    await core.destroyWorld(handle);
  });

  it('never fails the task when GitHub is unreachable', async () => {
    const gh = fakeGithub();
    const core = await coreFor({ ...gh, options: { apiBase: 'https://api.github.test',
      fetch: (async () => { throw new Error('network down'); }) as unknown as typeof fetch } });
    const handle = await core.createWorld({ taskId: 'task_down', repo: await repoWithGithubOrigin('svc'),
      base: 'main', target: 'main', kind: 'worktree' });
    await expect(core.finalizePrs(handle, [ref()], { target: 'main', pushed: ['svc'] })).resolves.toEqual([ref()]);
    await expect(core.closePrs(handle, [ref()], 'cancelled')).resolves.toEqual([ref()]);
    await core.destroyWorld(handle);
  });

  it('closes the still-open PR when the task is cancelled', async () => {
    const { gh, core, handle, prs } = await withOpenPr();
    const settled = await core.closePrs(handle, prs, 'The tavya task for this branch was cancelled; closing the pull request.');
    expect(gh.prs[0].state).toBe('closed');
    expect(settled[0]).toMatchObject({ state: 'closed', merged: false });
    expect(gh.comments[0]!.body).toContain('cancelled');
    // A second cancel pass is a no-op: the PR is already closed.
    await core.closePrs(handle, prs, 'again');
    expect(gh.comments).toHaveLength(1);
    await core.destroyWorld(handle);
  });

  it('reports a manually merged PR as merged instead of merely closed during cancellation', async () => {
    const { gh, core, handle, prs } = await withOpenPr();
    gh.prs[0].state = 'closed';
    gh.prs[0].merged_at = '2026-08-10T00:00:00Z';

    const settled = await core.closePrs(handle, prs, 'cancelled');

    expect(settled[0]).toMatchObject({ state: 'closed', merged: true });
    expect(gh.comments).toHaveLength(0);
    await core.destroyWorld(handle);
  });
});

describe('GitHub PR state → task view', () => {
  const pr = { repo: 'app', slug: SLUG, number: 85, url: `https://github.com/${SLUG}/pull/85`,
    state: 'open' as const };
  const view = { taskId: 'task_24', title: 'Work', workflow: 'software-dev', stage: 'review' as const,
    status: 'waiting' as const, messages: [], actions: [], state: {}, updatedAt: 1,
    pr, prs: [pr], checkouts: [{ name: 'app', branch: 'tavya/task_24', base: 'main', pr }] };

  it('reconciles every PR projection and never regresses an observed merge', () => {
    const merged = reconcilePullRequestView(view, { repo: SLUG, number: 85, state: 'closed', merged: true });
    expect(merged.pr).toMatchObject({ state: 'closed', merged: true });
    expect(merged.prs?.[0]).toMatchObject({ state: 'closed', merged: true });
    expect(merged.checkouts?.[0]?.pr).toMatchObject({ state: 'closed', merged: true });

    const delayed = reconcilePullRequestView(merged, { repo: SLUG, number: 85, state: 'open', merged: false });
    expect(delayed.pr).toMatchObject({ state: 'closed', merged: true });
  });
});

describe('PR webhooks → karmax events', () => {
  const delivery = (action: string, over: Record<string, unknown> = {}) => ({
    action,
    repository: { id: 99, full_name: SLUG },
    pull_request: { number: 7, html_url: `https://github.com/${SLUG}/pull/7`, state: 'open',
      title: 'Work', head: { ref: 'tavya/task_abc', repo: { id: 99 } }, base: { ref: 'main' }, ...over },
  });

  it('rejects fork PRs, fork checks and untrusted reviews naming a task branch', () => {
    expect(pullRequestWebhookEvent('pull_request', delivery('closed', {
      merged: true, head: { ref: 'tavya/task_abc', repo: { id: 100 } },
    }))).toBeUndefined();
    expect(pullRequestWebhookEvent('check_run', { action: 'completed', repository: { id: 99 },
      check_run: { check_suite: { head_branch: 'tavya/task_abc' },
        pull_requests: [{ head: { ref: 'tavya/task_abc', repo: { id: 100 } } }] },
    })).toBeUndefined();
    for (const association of ['NONE', 'FIRST_TIMER', 'CONTRIBUTOR', undefined]) {
      expect(pullRequestWebhookEvent('pull_request_review', { ...delivery('submitted'),
        review: { state: 'approved', author_association: association },
      })).toBeUndefined();
    }
  });

  it('maps a merged PR to github.pr.merged, correlated to its task', () => {
    const event = pullRequestWebhookEvent('pull_request',
      delivery('closed', { state: 'closed', merged: true, merged_at: '2026-01-01T00:00:00Z' }));
    expect(event).toMatchObject({ taskId: 'task_abc', type: 'github.pr.merged' });
    expect(event!.payload).toMatchObject({ number: 7, repo: SLUG, branch: 'tavya/task_abc', target: 'main',
      merged: true, state: 'closed', action: 'merged' });
  });

  it('distinguishes a closed-unmerged PR, reviews, and foreign branches', () => {
    expect(pullRequestWebhookEvent('pull_request', delivery('closed', { state: 'closed' }))?.type).toBe('github.pr.closed');
    expect(pullRequestWebhookEvent('pull_request', delivery('opened'))?.type).toBe('github.pr.opened');
    const review = pullRequestWebhookEvent('pull_request_review',
      { ...delivery('submitted'), review: { author_association: 'COLLABORATOR', state: 'approved', user: { login: 'ada' } } });
    expect(review).toMatchObject({ type: 'github.pr.review' });
    expect(review!.payload).toMatchObject({ review: 'approved', reviewer: 'ada' });
    // A human's own PR is not a karmax task's PR.
    expect(pullRequestWebhookEvent('pull_request',
      delivery('opened', { head: { ref: 'feature/manual' } }))).toBeUndefined();
    expect(pullRequestWebhookEvent('push', delivery('opened'))).toBeUndefined();
  });

  it('correlates a completed check run to the task branch for prompt reconciliation', () => {
    const event = pullRequestWebhookEvent('check_run', {
      action: 'completed', repository: { id: 99, full_name: SLUG }, check_run: {
        name: 'CI', status: 'completed', conclusion: 'failure', details_url: 'https://ci.test/run/1',
        check_suite: { head_branch: 'tavya/task_abc' },
        pull_requests: [{ head: { ref: 'tavya/task_abc', repo: { id: 99 } } }],
      },
    });
    expect(event).toMatchObject({ taskId: 'task_abc', type: 'github.check.completed', payload: {
      name: 'CI', conclusion: 'failure', branch: 'tavya/task_abc', repo: SLUG,
    } });
    expect(pullRequestWebhookEvent('check_run', {
      action: 'created', check_run: { check_suite: { head_branch: 'tavya/task_abc' } },
    })).toBeUndefined();
  });

  it('an event trigger matches the merged event', async () => {
    const { eventMatchesEventTrigger } = await import('../src/domain/triggers.js');
    const event = pullRequestWebhookEvent('pull_request',
      delivery('closed', { state: 'closed', merged: true }))!;
    const karmaxEvent = { taskId: event.taskId, type: event.type, ts: 1, payload: event.payload, seq: 1 };
    expect(eventMatchesEventTrigger({ kind: 'event', type: 'github.pr.merged', where: { target: 'main' } }, karmaxEvent)).toBe(true);
    expect(eventMatchesEventTrigger({ kind: 'event', type: 'github.pr.merged', where: { target: 'release' } }, karmaxEvent)).toBe(false);
  });

  /** A trigger can only be built on an event the picker offers, so the catalog
   *  is part of the feature — and a payload key it doesn't declare is a filter
   *  nobody can write. */
  it('declares every emitted PR event, and every key of its payload, in the event catalog', async () => {
    const { eventCatalog } = await import('../src/contrib/manifests.js');
    const byType = new Map(eventCatalog().map((e) => [e.type, e]));
    const emitted = [
      pullRequestWebhookEvent('pull_request', delivery('opened'))!,
      pullRequestWebhookEvent('pull_request', delivery('closed', { state: 'closed' }))!,
      pullRequestWebhookEvent('pull_request', delivery('closed', { state: 'closed', merged: true }))!,
      pullRequestWebhookEvent('pull_request_review',
        { ...delivery('submitted'), review: { author_association: 'COLLABORATOR', state: 'approved', user: { login: 'ada' } } })!,
      pullRequestWebhookEvent('check_run', {
        action: 'completed', repository: { id: 99, full_name: SLUG }, check_run: {
          name: 'CI', status: 'completed', conclusion: 'success', details_url: 'https://ci.test/run/1',
          check_suite: { head_branch: 'tavya/task_abc' },
        pull_requests: [{ head: { ref: 'tavya/task_abc', repo: { id: 99 } } }],
        },
      })!,
    ];
    for (const event of emitted) {
      const declared = byType.get(event.type);
      expect(declared, `${event.type} is not in the event catalog`).toBeDefined();
      expect(declared!.source).toBe('platform');
      for (const key of Object.keys(event.payload))
        expect(Object.keys(declared!.fields), `${event.type}.${key} is undeclared`).toContain(key);
    }
  });
});
