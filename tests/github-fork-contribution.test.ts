import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { bootHarness, Harness } from './helpers/harness.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import { git, gitOrThrow } from '../src/world/git.js';
import { GitProfiles, userGitScope } from '../src/autonomy/git-profiles.js';

/** Working on a repository someone else owns (real Temporal + git, stub
 *  GitHub). The project holds the person's fork of acme/widgets. The App is
 *  installed on the fork only, so tavya pushes there and the pull request goes
 *  to acme/widgets after Review, where acme's maintainers land it. */

const UPSTREAM = 'acme/widgets';
const FORK = 'jane/widgets';
const FORK_URL = `git@github.com:${FORK}.git`;
const PERSONAL_TOKEN = 'ghp_personal';
const prs: any[] = [];
const calls: Array<{ method: string; path: string; auth: string; body?: any }> = [];
let forkOrigin: string;
let originDir: string;

async function forkHead(branch: string): Promise<string | undefined> {
  const head = await git(forkOrigin, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]);
  return head.code === 0 ? head.stdout.trim() : undefined;
}

/** Someone opens the pull request on GitHub (the person, or their token). */
async function openUpstreamPr(branch: string, title = 'Proposed', body = ''): Promise<any> {
  const pr = { repo: UPSTREAM, number: prs.length + 1, node_id: `PR_${prs.length + 1}`,
    html_url: `https://github.com/${UPSTREAM}/pull/${prs.length + 1}`, state: 'open', merged_at: null,
    title, body, head: { ref: branch, sha: await forkHead(branch), repo: { full_name: FORK } },
    base: { ref: 'main' } };
  prs.push(pr);
  return pr;
}

const fetcher = (async (url: string, init: RequestInit = {}) => {
  const u = new URL(String(url));
  const method = init.method ?? 'GET';
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  const auth = new Headers(init.headers).get('authorization') ?? '';
  calls.push({ method, path: `${u.pathname}${u.search}`, auth, body });
  const json = (status: number, value: unknown) =>
    new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  for (const pr of prs) if (pr.state === 'open') pr.head.sha = await forkHead(pr.head.ref) ?? pr.head.sha;
  if (u.pathname === `/repos/${UPSTREAM}/pulls` && method === 'GET') {
    const [owner, branch] = (u.searchParams.get('head') ?? '').split(':');
    return json(200, prs.filter((pr) => owner === 'jane' && pr.head.ref === branch).reverse());
  }
  if (u.pathname === `/repos/${UPSTREAM}/pulls` && method === 'POST') {
    // GitHub's rule: no App token writes where the App is not installed.
    if (auth !== `Bearer ${PERSONAL_TOKEN}`) return json(403, { message: 'Resource not accessible by integration' });
    const [owner, branch] = String(body.head).split(':');
    if (owner !== 'jane' || !branch) return json(422, { message: 'Validation Failed' });
    return json(201, await openUpstreamPr(branch, body.title, body.body));
  }
  const one = u.pathname.match(/^\/repos\/acme\/widgets\/pulls\/(\d+)$/);
  if (one) {
    const pr = prs.find((candidate) => candidate.number === Number(one[1]));
    if (!pr) return json(404, { message: 'Not Found' });
    if (method === 'PATCH') {
      if (auth !== `Bearer ${PERSONAL_TOKEN}`) return json(403, { message: 'Resource not accessible by integration' });
      Object.assign(pr, body);
    }
    return json(200, pr);
  }
  if (u.pathname === '/graphql' && method === 'POST' && String(body?.query).includes('PullRequestReadiness')) {
    const pr = prs.find((candidate) => candidate.number === Number(body.variables?.number));
    return json(200, { data: { repository: { pullRequest: {
      id: pr?.node_id, url: pr?.html_url, state: pr?.merged_at ? 'MERGED' : 'OPEN', isDraft: false,
      merged: Boolean(pr?.merged_at), headRefOid: pr?.head?.sha,
      // Upstream maintainers have yet to review it.
      mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED',
      statusCheckRollup: { state: 'SUCCESS', contexts: { nodes: [] } },
      viewerCanEnableAutoMerge: false, viewerCanMergeAsAdmin: false,
    } } } });
  }
  if (u.pathname === '/graphql') return json(200, { errors: [{ message: 'Resource not accessible by integration' }] });
  return json(404, { message: `unrouted ${method} ${u.pathname}` });
}) as unknown as typeof fetch;

const view = (handle: any) => handle.query('view') as Promise<any>;
const upstreamWrites = () => calls.filter((call) => call.method !== 'GET' && call.path.startsWith(`/repos/${UPSTREAM}/`));

describe('software-dev 1.28 on a fork of someone else\'s repository', () => {
  let h: Harness;
  beforeAll(async () => {
    originDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-fork-origin-'));
    h = await bootHarness('mock', undefined, {
      githubPr: { apiBase: 'https://api.github.test', fetch: fetcher },
      githubApp: {
        status: () => ({ userAuthorized: true, oauthConfigured: true }),
        activeUserAccountId: (userId: string) => `${userId}-github`,
        // The person may not merge upstream; it is not theirs.
        repositoryPermission: async (_userId: string, slug: string) => ({ slug, permission: 'read', canMerge: false }),
        userAccessToken: async (userId: string) => `${userId}-app-token`,
        installationToken: async () => 'installation-token',
        brokerCredentials: async () => ({ env: {} }),
        repositoryCloneToken: async () => 'clone-token',
        syncFork: async () => ({ synced: true, detail: 'fast-forward' }),
      } as any,
    });
    await h.store.claimPersonalOrganization('jane');
  }, 120_000);
  afterAll(async () => {
    await h?.stop();
    if (originDir) fs.rmSync(originDir, { recursive: true, force: true });
  });
  beforeEach(() => {
    prs.length = 0;
    calls.length = 0;
  });

  async function forkProject(name: string) {
    const repo = await h.makeRepo(name);
    forkOrigin = path.join(originDir, `${name}.git`);
    await gitOrThrow(originDir, ['init', '-q', '--bare', '-b', 'main', forkOrigin]);
    await git(repo, ['remote', 'add', 'origin', FORK_URL]);
    await git(repo, ['config', `url.${forkOrigin}.insteadOf`, FORK_URL]);
    await git(repo, ['push', '-q', 'origin', 'main']);
    const project = await h.store.createProject(`Fork ${name}`, { repos: [repo], remote: 'pr' });
    const connection = await h.store.upsertGitConnection({ organizationId: project.organizationId!, provider: 'github',
      installationId: '42', accountLogin: 'jane', accountType: 'User' });
    const fork = await h.store.upsertRepository({ organizationId: project.organizationId!, provider: 'github', providerId: '77',
      owner: 'jane', name: 'widgets', sshUrl: FORK_URL, defaultBranch: 'main', private: false, gitConnectionId: connection.id,
      upstream: { owner: 'acme', name: 'widgets', defaultBranch: 'main', private: false } });
    await h.store.attachProjectRepository({ projectId: project.id, repositoryId: fork.id });
    return { repo, project };
  }

  async function start(name: string, project: { id: string }, repo: string) {
    const task = await h.store.createTask({ projectId: project.id, title: 'Fix the widget', workflow: 'software-dev',
      workflowVersion: '1.28.0', params: { prompt: 'Fix it', base: 'main', target: 'main', _repositoryBranchesResolved: true },
      createdBy: { kind: 'user', userId: 'jane' } });
    const handle = await h.client.workflow.start('softwareDev@1.28.0', {
      taskQueue: TASK_QUEUE, workflowId: task.id, args: [{
        taskId: task.id, projectId: project.id, title: 'Fix the widget',
        prompt: `@write ${name}.txt :: fixed\n@run git add -A && git commit -qm fix\n@review Fixed the widget`,
        base: 'main', target: 'main', githubPollMs: 300, project: { repos: [repo], remote: 'pr' },
      }],
    });
    return { task, handle };
  }

  it('stores and reads the fork\'s upstream', async () => {
    const { project } = await forkProject('stored');
    const [attached] = await h.store.listProjectRepositories(project.id);
    expect(attached?.repository.upstream).toEqual({ owner: 'acme', name: 'widgets', defaultBranch: 'main', private: false });
  });

  it('without a personal token, asks the person to open the upstream pull request and follows it until merged', async () => {
    const { repo, project } = await forkProject('manual');
    const { task, handle } = await start('manual', project, repo);
    const branch = `tavya/${task.id}`;

    await expect.poll(async () => (await view(handle)).stage, { timeout: 60_000 }).toBe('review');
    // The branch reached the fork, but nothing reached the upstream before Review.
    expect(await forkHead(branch)).toBeTruthy();
    expect(prs).toHaveLength(0);
    expect(upstreamWrites()).toEqual([]);
    expect((await h.store.eventsOfTypes(task.id, ['pr.upstream-pending'])).at(-1)?.payload)
      .toMatchObject({ slug: UPSTREAM, headRepository: FORK });

    await handle.signal('confirm');
    await expect.poll(async () => (await view(handle)).waitingFor?.summary, { timeout: 30_000 })
      .toBe('Open the pull request on GitHub');
    const waiting = await view(handle);
    expect(waiting.waitingFor).toMatchObject({ kind: 'human', audience: ['@creator'] });
    const link = waiting.waitingFor.detail.match(/\((https:[^)]+)\)/)?.[1];
    expect(link).toBeTruthy();
    const page = new URL(link);
    expect(page.pathname).toBe(`/${UPSTREAM}/compare/main...jane:widgets:${branch}`);
    expect(page.searchParams.get('quick_pull')).toBe('1');
    expect(page.searchParams.get('title')).toBe('Fix the widget');
    // tavya tried no write it could not make.
    expect(upstreamWrites()).toEqual([]);

    // The person opens it on GitHub; tavya finds it and hands landing to acme.
    await openUpstreamPr(branch);
    await handle.signal('confirm');
    await expect.poll(async () => (await view(handle)).waitingFor?.detail ?? '', { timeout: 30_000 })
      .toMatch(/waiting for its maintainers/);
    const landing = await view(handle);
    expect(landing.prs).toEqual([expect.objectContaining({ slug: UPSTREAM, number: 1, headRepository: FORK })]);
    expect(landing.stage).toBe('merge');

    prs[0].state = 'closed';
    prs[0].merged_at = new Date().toISOString();
    prs[0].merged = true;
    prs[0].merge_commit_sha = prs[0].head.sha;
    expect((await handle.result()).stage).toBe('done');
    expect((await view(handle)).prs[0]).toMatchObject({ slug: UPSTREAM, merged: true });
    // Merging belonged to acme: tavya never wrote to their repository.
    expect(upstreamWrites()).toEqual([]);
  }, 180_000);

  it('with the person\'s own GitHub token, opens the upstream pull request itself after Review', async () => {
    const profiles = new GitProfiles(h.store, h.broker, undefined, userGitScope('jane'));
    await profiles.save({ name: 'github', userName: 'Jane', userEmail: 'jane@example.com',
      github: { id: 'jane-github', login: 'jane' }, githubToken: PERSONAL_TOKEN });
    try {
      const { repo, project } = await forkProject('token');
      const { task, handle } = await start('token', project, repo);
      const branch = `tavya/${task.id}`;

      await expect.poll(async () => (await view(handle)).stage, { timeout: 60_000 }).toBe('review');
      expect(prs).toHaveLength(0);
      expect(upstreamWrites()).toEqual([]);

      await handle.signal('confirm');
      await expect.poll(async () => (await view(handle)).waitingFor?.detail ?? '', { timeout: 30_000 })
        .toMatch(/waiting for its maintainers/);
      expect(prs).toHaveLength(1);
      expect(prs[0]).toMatchObject({ title: 'Fix the widget', head: { ref: branch } });
      // Maintainers see the change, not this deployment's task references.
      expect(prs[0].body).not.toMatch(/task_/);
      const opened = upstreamWrites().filter((call) => call.method === 'POST');
      expect(opened).toEqual([expect.objectContaining({ auth: `Bearer ${PERSONAL_TOKEN}`,
        body: expect.objectContaining({ head: `jane:${branch}`, base: 'main' }) })]);

      prs[0].state = 'closed';
      prs[0].merged_at = new Date().toISOString();
      prs[0].merged = true;
      expect((await handle.result()).stage).toBe('done');
    } finally {
      await profiles.delete('github');
    }
  }, 180_000);
});
