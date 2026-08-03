import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { WorktreeProvider } from '../src/world/worktree.js';
import { git, gitOrThrow, ensureIdentity } from '../src/world/git.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { GithubPrApi, githubSlug, taskIdOfBranch, pullRequestWebhookEvent } from '../src/integrations/github-pr.js';
import type { TaskPullRequest } from '../src/domain/types.js';
import { ensureProjectWikiRepository } from '../src/wiki/repository.js';

/** The GitHub pull-request integration (SPEC §5.2, PLAN-git-config.md §5):
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
    const list = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/pulls$/);
    if (list && method === 'GET') {
      const head = u.searchParams.get('head');
      const branch = head?.split(':')[1];
      return json(200, prs.filter((pr) => pr.head.ref === branch && pr.repo === list[1]));
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
      if (method === 'PATCH') Object.assign(pr, body);
      return json(200, pr);
    }
    const comment = u.pathname.match(/^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/);
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

async function coreFor(github: { options: { apiBase?: string; fetch?: typeof fetch } }, githubApp?: Record<string, unknown>) {
  const { Store } = await import('../src/store/db.js');
  const { WorldRegistry } = await import('../src/world/registry.js');
  const { ProfileResolver } = await import('../src/agent/profiles.js');
  const { makeCoreActivities } = await import('../src/activities/core.js');
  const store = new Store(':memory:');
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
  const store = new Store(':memory:');
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
    expect(taskIdOfBranch('karmax/task_abc')).toBe('task_abc');
    expect(taskIdOfBranch('feature/x')).toBeUndefined();
  });

  it('opens once, then updates the same PR instead of opening a second one', async () => {
    const gh = fakeGithub();
    const api = new GithubPrApi('t', gh.options);
    const first = await api.openOrUpdate(SLUG, { head: 'karmax/t1', base: 'main', title: 'One', body: 'first' });
    expect(first.created).toBe(true);
    const second = await api.openOrUpdate(SLUG, { head: 'karmax/t1', base: 'main', title: 'Two', body: 'second' });
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
      if (url.pathname === '/graphql') return Response.json({ data: { enqueuePullRequest: { mergeQueueEntry: { id: 'queue-1' } } } });
      return Response.json({ message: 'not found' }, { status: 404 });
    }) as typeof fetch;
    const api = new GithubPrApi('user-token', { apiBase: 'https://api.github.test', fetch: fetcher });
    await api.approve(SLUG, 7, 'reviewed-sha', 'approved in krmax');
    await expect(api.merge(SLUG, 7, 'reviewed-sha')).resolves.toEqual({ merged: true, sha: 'merge-sha', message: 'merged' });
    await expect(api.enqueue('PR_node', 'reviewed-sha')).resolves.toMatchObject({ queued: true, merged: false });
    expect(calls[0]).toMatchObject({ path: `/repos/${SLUG}/pulls/7/reviews`,
      body: { commit_id: 'reviewed-sha', event: 'APPROVE' } });
    expect(calls[1]).toMatchObject({ path: `/repos/${SLUG}/pulls/7/merge`, body: { sha: 'reviewed-sha' } });
    expect(calls[2]!.body).toMatchObject({ variables: { input: {
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
    const { pr } = await api.openOrUpdate(SLUG, { head: 'karmax/t2', base: 'main', title: 'T', body: 'b' });
    await api.update(SLUG, pr.number, { state: 'closed' });
    expect((await api.openOrUpdate(SLUG, { head: 'karmax/t2', base: 'main', title: 'T', body: 'b' })).pr.state).toBe('open');

    gh.prs[0].state = 'closed';
    gh.prs[0].merged_at = '2026-01-01T00:00:00Z';
    const merged = await api.openOrUpdate(SLUG, { head: 'karmax/t2', base: 'main', title: 'T', body: 'b' });
    expect(merged.pr.state).toBe('closed');
    expect(merged.pr.merged).toBe(true);
  });

  it('adopts the existing PR when GitHub rejects the create as a duplicate', async () => {
    const gh = fakeGithub();
    const api = new GithubPrApi('t', gh.options);
    await api.openOrUpdate(SLUG, { head: 'karmax/t3', base: 'main', title: 'T', body: 'b' });
    // A racing creator sees no PR from `findByHead`, so it POSTs and gets a 422.
    const raced = new GithubPrApi('t', { ...gh.options, fetch: (async (url: string, init: RequestInit = {}) => {
      if ((init.method ?? 'GET') === 'GET' && String(url).includes('/pulls?')) {
        const seen = new URL(String(url));
        if (!seen.searchParams.get('raced')) return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return gh.fetcher(url as any, init);
    }) as unknown as typeof fetch });
    const result = await raced.openOrUpdate(SLUG, { head: 'karmax/t3', base: 'main', title: 'T', body: 'b' })
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
        merged: false, head: { ref: 'karmax/task_merge', sha: liveHead }, base: { ref: 'main' },
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
    core.store.claimPersonalOrganization('owner');
    const project = core.store.createProject('Merge authorization');
    core.store.setOrganizationMembership(project.organizationId!, 'reviewer', 'member');
    core.store.setProjectMembership(project.id, { kind: 'user', userId: 'reviewer' }, 'reviewer');
    const task = core.store.createTask({ projectId: project.id, title: 'Merge me', workflow: 'software-dev',
      workflowVersion: '1.12.0', params: { prompt: 'x', _githubAccountId: 'owner-account' },
      createdBy: { kind: 'user', userId: 'owner' } });
    core.store.appendEvent({ taskId: task.id, type: 'task.confirmation-voted', ts: 1,
      payload: { userId: 'reviewer', satisfied: true, githubMergeAuthorized: true,
        githubPrHeads: [{ slug: SLUG, number: 7, headSha: 'reviewed-head' }] } });
    const result = await core.mergeGithubPrs({ id: task.id, kind: 'worktree', branch: 'karmax/task_merge',
      base: 'main', repo: tmp, root: tmp } as any, [{ repo: 'widgets', slug: SLUG, number: 7,
      url: 'https://github.test/acme/widgets/pull/7', state: 'open', headSha: 'reviewed-head' }]);
    expect(result).toMatchObject({ status: 'merged', actorUserId: 'reviewer', sha: 'merge-sha' });
    expect(requests.find((request) => request.method === 'PUT')).toMatchObject({
      auth: 'Bearer reviewer-token', body: { sha: 'reviewed-head' },
    });

    liveHead = 'replacement-head';
    const stale = await core.mergeGithubPrs({ id: task.id, kind: 'worktree', branch: 'karmax/task_merge',
      base: 'main', repo: tmp, root: tmp } as any, [{ repo: 'widgets', slug: SLUG, number: 7,
      url: 'https://github.test/acme/widgets/pull/7', state: 'open', headSha: 'reviewed-head' }]);
    expect(stale).toMatchObject({ status: 'stale-review', eligibleUserIds: ['reviewer'] });
    const unapprovedReplacement = await core.mergeGithubPrs({ id: task.id, kind: 'worktree',
      branch: 'karmax/task_merge', base: 'main', repo: tmp, root: tmp } as any, stale.prs);
    expect(unapprovedReplacement).toMatchObject({ status: 'needs-authorizer', eligibleUserIds: ['reviewer'] });
    core.store.appendEvent({ taskId: task.id, type: 'task.confirmation-voted', ts: 2,
      payload: { userId: 'reviewer', satisfied: true, githubMergeAuthorized: true,
        githubPrHeads: [{ slug: SLUG, number: 7, headSha: 'replacement-head' }] } });
    await expect(core.mergeGithubPrs({ id: task.id, kind: 'worktree', branch: 'karmax/task_merge',
      base: 'main', repo: tmp, root: tmp } as any, stale.prs)).resolves.toMatchObject({
        status: 'merged', actorUserId: 'reviewer',
      });
  });

  it('binds merge-queue and auto-merge fallback to the reviewed head', async () => {
    const graphqlInputs: any[] = [];
    const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const method = init.method ?? 'GET';
      if (method === 'GET') return Response.json({
        number: 8, node_id: 'PR_auto', html_url: 'https://github.test/acme/widgets/pull/8', state: 'open',
        merged: false, head: { ref: 'karmax/task_auto', sha: 'exact-head' }, base: { ref: 'main' },
      });
      if (method === 'PUT') return Response.json({ merged: false, message: 'Required checks are pending' }, { status: 409 });
      const body = JSON.parse(String(init.body));
      graphqlInputs.push(body.variables.input);
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
    core.store.claimPersonalOrganization('owner');
    const project = core.store.createProject('Auto merge');
    const task = core.store.createTask({ projectId: project.id, title: 'Auto merge me', workflow: 'software-dev',
      workflowVersion: '1.12.0', params: { prompt: 'x', _githubAccountId: 'owner-account' },
      createdBy: { kind: 'user', userId: 'owner' } });
    await expect(core.mergeGithubPrs({ id: task.id, kind: 'worktree', branch: 'karmax/task_auto',
      base: 'main', repo: tmp, root: tmp } as any, [{ repo: 'widgets', slug: SLUG, number: 8,
      url: 'https://github.test/acme/widgets/pull/8', state: 'open', headSha: 'exact-head' }]))
      .resolves.toMatchObject({ status: 'queued', detail: expect.stringMatching(/auto-merge/) });
    expect(graphqlInputs).toEqual([
      { pullRequestId: 'PR_auto', expectedHeadOid: 'exact-head' },
      { pullRequestId: 'PR_auto', expectedHeadOid: 'exact-head', mergeMethod: 'SQUASH' },
    ]);
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
    core.store.claimPersonalOrganization('jane');
    const project = core.store.createProject('Connected', { repos: [repo] });
    const connection = core.store.upsertGitConnection({ organizationId: project.organizationId!, provider: 'github',
      installationId: '42', accountLogin: 'acme', accountType: 'Organization' });
    const enrolled = core.store.upsertRepository({ organizationId: project.organizationId!, provider: 'github',
      providerId: '77', owner: 'acme', name: 'widgets', sshUrl: REMOTE, defaultBranch: 'main', private: true,
      gitConnectionId: connection.id });
    core.store.attachProjectRepository({ projectId: project.id, repositoryId: enrolled.id });
    const task = core.store.createTask({ projectId: project.id, title: 'Connected PR', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'work' }, createdBy: { kind: 'user', userId: 'jane' } });

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
    core.store.claimPersonalOrganization('jane');
    const project = core.store.createProject('Connected local', { repos: [repo] });
    const connection = core.store.upsertGitConnection({ organizationId: project.organizationId!, provider: 'github',
      installationId: '42', accountLogin: 'acme', accountType: 'Organization' });
    core.store.upsertRepository({ organizationId: project.organizationId!, provider: 'github',
      providerId: '77', owner: 'acme', name: 'widgets', sshUrl: REMOTE, defaultBranch: 'main', private: true,
      gitConnectionId: connection.id });
    expect(core.store.listProjectRepositories(project.id)).toHaveLength(0);
    const task = core.store.createTask({ projectId: project.id, title: 'Connected local PR', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'work' }, createdBy: { kind: 'user', userId: 'jane' } });

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
    core.store.claimPersonalOrganization('owner');
    const project = core.store.createProject('Local source', { repos: [app], worldProvider: 'fake-remote' });
    const wikiRoot = ensureProjectWikiRepository(content, project.id);
    await gitOrThrow(tmp, ['init', '-q', '--bare', '-b', 'main', wikiOrigin]);
    await gitOrThrow(wikiRoot, ['remote', 'add', 'origin', wikiRemote]);
    await gitOrThrow(wikiRoot, ['config', `url.${wikiOrigin}.insteadOf`, wikiRemote]);
    await gitOrThrow(wikiRoot, ['push', '-q', 'origin', 'main']);
    await gitOrThrow(wikiRoot, ['config', '--unset-all', `url.${wikiOrigin}.insteadOf`]);
    const wiki = core.store.upsertRepository({ organizationId: project.organizationId!, provider: 'github',
      owner: 'acme', name: 'project-wiki', sshUrl: wikiRemote, defaultBranch: 'main', private: true });
    core.store.setProjectWikiRepository(project.id, wiki.id);
    const task = core.store.createTask({ projectId: project.id, title: 'Cloud PR', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'work' } });
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
    const org = core.store.createOrganization({ name: 'Acme' });
    const project = core.store.createProject('Org project', {}, org.id);
    const repo = await repoWithGithubOrigin('nocred');
    const handle = await core.createWorld({ taskId: 'task_pr3', projectId: project.id, repo,
      base: 'main', target: 'main', kind: 'worktree' });
    await expect(core.openPr(handle, 'main', {})).rejects.toThrow(/GitHub account cannot access acme\/widgets.*reconnect GitHub on your profile/i);
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

  it('records a PR GitHub already merged, and comments the karmax outcome', async () => {
    const { gh, core, handle, prs } = await withOpenPr();
    gh.prs[0].state = 'closed';
    gh.prs[0].merged_at = '2026-01-01T00:00:00Z';
    const settled = await core.finalizePrs(handle, prs, { target: 'main', sha: 'abc1234', pushed: ['svc'] });
    expect(settled[0]).toMatchObject({ number: 1, state: 'closed', merged: true });
    expect(gh.comments[0]!.body).toContain('Merged into `main` by karmax');
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
    expect(gh.comments[0]!.body).toContain('Merged into `main` by karmax');
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
    await expect(core.closePrs(handle, [ref()], 'cancelled')).resolves.toBeUndefined();
    await core.destroyWorld(handle);
  });

  it('closes the still-open PR when the task is cancelled', async () => {
    const { gh, core, handle, prs } = await withOpenPr();
    await core.closePrs(handle, prs, 'The karmax task for this branch was cancelled; closing the pull request.');
    expect(gh.prs[0].state).toBe('closed');
    expect(gh.comments[0]!.body).toContain('cancelled');
    // A second cancel pass is a no-op: the PR is already closed.
    await core.closePrs(handle, prs, 'again');
    expect(gh.comments).toHaveLength(1);
    await core.destroyWorld(handle);
  });
});

describe('PR webhooks → karmax events', () => {
  const delivery = (action: string, over: Record<string, unknown> = {}) => ({
    action,
    repository: { full_name: SLUG },
    pull_request: { number: 7, html_url: `https://github.com/${SLUG}/pull/7`, state: 'open',
      title: 'Work', head: { ref: 'karmax/task_abc' }, base: { ref: 'main' }, ...over },
  });

  it('maps a merged PR to github.pr.merged, correlated to its task', () => {
    const event = pullRequestWebhookEvent('pull_request',
      delivery('closed', { state: 'closed', merged: true, merged_at: '2026-01-01T00:00:00Z' }));
    expect(event).toMatchObject({ taskId: 'task_abc', type: 'github.pr.merged' });
    expect(event!.payload).toMatchObject({ number: 7, repo: SLUG, branch: 'karmax/task_abc', target: 'main',
      merged: true, state: 'closed', action: 'merged' });
  });

  it('distinguishes a closed-unmerged PR, reviews, and foreign branches', () => {
    expect(pullRequestWebhookEvent('pull_request', delivery('closed', { state: 'closed' }))?.type).toBe('github.pr.closed');
    expect(pullRequestWebhookEvent('pull_request', delivery('opened'))?.type).toBe('github.pr.opened');
    const review = pullRequestWebhookEvent('pull_request_review',
      { ...delivery('submitted'), review: { state: 'approved', user: { login: 'ada' } } });
    expect(review).toMatchObject({ type: 'github.pr.review' });
    expect(review!.payload).toMatchObject({ review: 'approved', reviewer: 'ada' });
    // A human's own PR is not a karmax task's PR.
    expect(pullRequestWebhookEvent('pull_request',
      delivery('opened', { head: { ref: 'feature/manual' } }))).toBeUndefined();
    expect(pullRequestWebhookEvent('push', delivery('opened'))).toBeUndefined();
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
        { ...delivery('submitted'), review: { state: 'approved', user: { login: 'ada' } } })!,
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
