import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { bootHarness, Harness } from './helpers/harness.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import { git, gitOrThrow } from '../src/world/git.js';
import { newId } from '../src/util/id.js';
import { MockAdapter } from '../src/agent/mock.js';
import type { AgentAdapter } from '../src/agent/types.js';
import { worldRepos } from '../src/world/types.js';

/** The PR stage end to end under remote policy 'pr' (SPEC §5.2): the workflow
 *  opens the pull request, carries it on the view, and reconciles it with the
 *  merge outcome. Real Temporal + git; GitHub is a stub endpoint. */

const SLUG = 'acme/pipeline';
const REMOTE = `git@github.com:${SLUG}.git`;
const prs: any[] = [];
const comments: { number: number; body: string }[] = [];
let afterPrOpened: (() => Promise<void>) | undefined;
let githubReadiness: Record<string, unknown> = {};
let mergeHttpStatus: number | undefined;
let useMergeQueue = false;
let mergeQueueAccepted = false;
let mergeFailureMessage: string | undefined;

const fetcher = (async (url: string, init: RequestInit = {}) => {
  const u = new URL(String(url));
  const method = init.method ?? 'GET';
  const body = init.body ? JSON.parse(String(init.body)) : {};
  const json = (status: number, value: unknown) =>
    new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  if (u.pathname === `/repos/${SLUG}/pulls` && method === 'GET') {
    const branch = u.searchParams.get('head')?.split(':')[1];
    return json(200, prs.filter((pr) => pr.head.ref === branch));
  }
  if (u.pathname === `/repos/${SLUG}/pulls` && method === 'POST') {
    const pr = { number: prs.length + 1, html_url: `https://github.com/${SLUG}/pull/${prs.length + 1}`,
      node_id: `PR_${prs.length + 1}`, state: 'open', merged_at: null, title: body.title, body: body.body,
      head: { ref: body.head, sha: 'reviewed-head' }, base: { ref: body.base } };
    prs.push(pr);
    const hook = afterPrOpened;
    afterPrOpened = undefined;
    await hook?.();
    return json(201, pr);
  }
  if (u.pathname === '/graphql' && method === 'POST' && String(body.query).includes('PullRequestReadiness')) {
    const pr = prs.find((candidate) => candidate.number === Number(body.variables?.number)) ?? prs[0];
    return json(200, { data: { repository: { pullRequest: {
      id: pr?.node_id ?? 'PR_1', url: pr?.html_url ?? `https://github.com/${SLUG}/pull/1`,
      state: pr?.state === 'closed' ? 'CLOSED' : 'OPEN', isDraft: false, merged: Boolean(pr?.merged_at),
      headRefOid: pr?.head?.sha ?? 'reviewed-head', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
      statusCheckRollup: { state: 'SUCCESS', contexts: { nodes: [] } },
      viewerCanEnableAutoMerge: false, viewerCanMergeAsAdmin: false,
      ...(mergeQueueAccepted ? { mergeQueueEntry: { id: 'MQ_pipeline' } } : {}),
      ...githubReadiness,
    } } } });
  }
  if (u.pathname === '/graphql' && method === 'POST' && String(body.query).includes('enqueuePullRequest')) {
    if (!useMergeQueue) return json(200, { errors: [{ message: 'This branch has no merge queue' }] });
    mergeQueueAccepted = true;
    return json(200, { data: { enqueuePullRequest: { mergeQueueEntry: { id: 'MQ_pipeline' } } } });
  }
  if (u.pathname === '/graphql' && method === 'POST') {
    return json(200, { errors: [{ message: mergeFailureMessage ?? 'GitHub did not accept the merge operation' }] });
  }
  const targetRef = u.pathname.match(new RegExp(`^/repos/${SLUG}/git/refs/heads/(.+)$`));
  if (targetRef && method === 'PATCH') {
    const pr = prs.find((candidate) => candidate.head.sha === body.sha);
    if (!pr) return json(422, { message: 'Update is not a fast forward' });
    pr.state = 'closed'; pr.merged_at = new Date().toISOString();
    return json(200, { ref: `refs/heads/${decodeURIComponent(targetRef[1]!)}`, object: { sha: body.sha } });
  }
  const merge = u.pathname.match(new RegExp(`^/repos/${SLUG}/pulls/(\\d+)/merge$`));
  if (merge && method === 'PUT') {
    const pr = prs.find((candidate) => candidate.number === Number(merge[1]));
    if (!pr) return json(404, {});
    if (useMergeQueue) return json(409, { merged: false, message: 'merge queue required' });
    if (mergeHttpStatus) return json(mergeHttpStatus, {
      merged: false,
      message: mergeFailureMessage ?? (mergeHttpStatus >= 500 ? 'GitHub merge service unavailable' : 'GitHub refused the merge'),
    });
    if (body.sha !== pr.head.sha) return json(409, { merged: false, message: 'Head branch was modified' });
    pr.state = 'closed'; pr.merged_at = new Date().toISOString();
    return json(200, { merged: true, sha: 'github-merge-sha', message: 'merged' });
  }
  const one = u.pathname.match(new RegExp(`^/repos/${SLUG}/pulls/(\\d+)$`));
  if (one) {
    const pr = prs.find((candidate) => candidate.number === Number(one[1]));
    if (!pr) return json(404, {});
    if (method === 'PATCH') {
      const { base, ...rest } = body;
      Object.assign(pr, rest);
      if (typeof base === 'string') pr.base = { ref: base };
    }
    return json(200, pr);
  }
  const comment = u.pathname.match(new RegExp(`^/repos/${SLUG}/issues/(\\d+)/comments$`));
  if (comment && method === 'POST') {
    comments.push({ number: Number(comment[1]), body: body.body });
    return json(201, {});
  }
  return json(404, { message: `unrouted ${method} ${u.pathname}` });
}) as unknown as typeof fetch;

const view = (h: any) => h.query('view') as Promise<any>;

describe('software-dev with remote policy "pr" (real Temporal + git, stub GitHub)', () => {
  let h: Harness;
  let originDir: string;
  beforeAll(async () => {
    process.env.GH_TOKEN = 'ghp_pipeline';
    const mock = new MockAdapter();
    const adapter: AgentAdapter = {
      provider: 'mock',
      async runTurn(input, ctx) {
        if (input.role === 'confirm'
          && input.messages.at(-1)?.text.includes('AUTOMATED INTEGRATION-REPAIR review')) {
          // The repaired proposal's external CI is green by the time the
          // independent integration reviewer admits it again.
          githubReadiness = {};
          return mock.runTurn({
            ...input,
            messages: [...input.messages, {
              id: `integration-verdict-${input.messages.length}`,
              role: 'user',
              text: '@confirm confirm',
              ts: input.messages.length,
            }],
          }, ctx);
        }
        // One test below needs a competent Merge agent that resolves a conflict
        // introduced after PR creation. Keep the ordinary mock behavior for every
        // other turn, including the existing "cannot resolve" pipeline coverage.
        if (input.role === 'merge'
          && input.systemPrompt.includes('Resolve after PR')
          && input.messages.at(-1)?.text.includes('unresolved conflicts')) {
          for (const repo of worldRepos(input.world.handle)) {
            await input.world.exec('git', ['merge', 'main'], { cwd: repo.root });
            await input.world.writeFile('conflict.txt', 'resolved after PR\n');
            await input.world.exec('git', ['add', '-A'], { cwd: repo.root });
            await input.world.exec('git', ['commit', '--no-edit', '-q'], { cwd: repo.root });
          }
        }
        return mock.runTurn(input, ctx);
      },
    };
    h = await bootHarness('mock', adapter, {
      githubPr: { apiBase: 'https://api.github.test', fetch: fetcher },
      githubApp: {
        status: () => ({ userAuthorized: true, oauthConfigured: true }),
        activeUserAccountId: (userId: string) => `${userId}-github`,
        repositoryPermission: async (_userId: string, slug: string) => ({ slug, permission: 'write', canMerge: true }),
        userAccessToken: async (userId: string) => `${userId}-token`,
        brokerCredentials: async () => ({ env: {} }),
      } as any,
    });
    originDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-pr-origin-'));
  }, 120_000);
  afterAll(async () => {
    delete process.env.GH_TOKEN;
    await h?.stop();
    if (originDir) fs.rmSync(originDir, { recursive: true, force: true });
  });
  beforeEach(() => {
    prs.length = 0;
    comments.length = 0;
    afterPrOpened = undefined;
    githubReadiness = {};
    mergeHttpStatus = undefined;
    useMergeQueue = false;
    mergeQueueAccepted = false;
    mergeFailureMessage = undefined;
  });

  /** origin reads as GitHub (so the PR is keyed on the slug) and pushes to a
   *  local bare repo (so the push is real). */
  async function repoWithOrigin(name: string): Promise<string> {
    const repo = await h.makeRepo(name);
    const origin = path.join(originDir, `${name}.git`);
    await gitOrThrow(originDir, ['init', '-q', '--bare', '-b', 'main', origin]);
    await git(repo, ['remote', 'add', 'origin', REMOTE]);
    await git(repo, ['config', `url.${origin}.insteadOf`, REMOTE]);
    await git(repo, ['push', '-q', 'origin', 'main']);
    return repo;
  }

  it('opens the PR at the PR stage and closes it once the merge lands', async () => {
    const repo = await repoWithOrigin('app');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev@1.8.0', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [{
        taskId,
        projectId: 'p1',
        title: 'Add a greeter',
        // The Do agent commits its own work — without a commit the branch has
        // nothing to propose and GitHub rejects the pull request outright.
        prompt: 'Implement it.\n@write greet.js :: export const g = () => "hi";\n'
          + '@run git add -A && git commit -q -m "add greet.js"\n@review Added greet.js',
        base: 'main',
        target: 'main',
        project: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', remote: 'pr' },
      }],
    });

    await expect.poll(async () => (await view(handle)).stage, { timeout: 30_000 }).toBe('review');
    expect((await view(handle)).pr).toBeUndefined(); // Review IS the gate; the PR comes after it
    await handle.signal('confirm');
    const result = await handle.result();
    expect(result.stage).toBe('done');

    expect(prs).toHaveLength(1);
    expect(prs[0].title).toBe('Add a greeter');
    expect(prs[0].body).toContain('greet.js');
    expect(prs[0].head.ref).toBe(`karmax/${taskId}`);
    // The branch reached origin, the merge landed, and the PR was reconciled.
    const origin = path.join(originDir, 'app.git');
    expect((await git(origin, ['rev-parse', '--verify', `karmax/${taskId}`])).code).toBe(0);
    expect((await git(origin, ['show', 'main:greet.js'])).stdout).toContain('export const g');
    expect(prs[0].state).toBe('closed');
    expect(comments.map((c) => c.body).join('\n')).toContain('merged this branch into `main`');

    const final = await view(handle);
    expect(final.prs).toHaveLength(1);
    expect(final.prs[0]).toMatchObject({ slug: SLUG, number: 1, state: 'closed' });
    expect(final.prs[0].repo).toContain('app');
    expect(final.pr.url).toBe(`https://github.com/${SLUG}/pull/1`);
  }, 120_000);

  it('has the Merge agent commit and prepare an uncommitted Do result before opening the PR', async () => {
    const repo = await repoWithOrigin('uncommitted');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev@1.11.0', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [{
        taskId,
        projectId: 'p1',
        title: 'Commit before PR',
        // Task 399's exact shape: Do creates the requested file and finishes
        // without committing it. The branch-preparation half of Merge must run
        // before openPr, because GitHub cannot open a PR for a dirty-but-empty
        // branch. The protected-target merge still happens afterwards.
        prompt: '@write kablooga.md :: # Kablooga\n@review Added kablooga.md',
        base: 'main',
        target: 'main',
        project: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', remote: 'pr' },
      }],
    });

    await expect.poll(async () => (await view(handle)).stage, { timeout: 30_000 }).toBe('review');
    await handle.signal('confirm');
    expect((await handle.result()).stage).toBe('done');

    expect(prs).toHaveLength(1);
    expect(prs[0].head.ref).toBe(`karmax/${taskId}`);
    const origin = path.join(originDir, 'uncommitted.git');
    // The proposed remote branch already contains the Merge agent's commit;
    // preparation did not happen only after the PR had captured an empty head.
    expect((await git(origin, ['show', `karmax/${taskId}:kablooga.md`])).stdout)
      .toContain('# Kablooga');
    expect((await git(origin, ['show', 'main:kablooga.md'])).stdout)
      .toContain('# Kablooga');
    const final = await view(handle);
    const merge = final.transcripts.find((transcript: any) => transcript.role === 'merge');
    expect(merge.messages.map((message: any) => message.text).join('\n')).toMatch(/before opening the pull request/i);
    expect(merge.messages.filter((message: any) => message.role === 'user')).toHaveLength(1); // no duplicate initial Merge turn
  }, 120_000);

  it('v1.13 opens the explicit proposal before Review and merges without a Merge agent', async () => {
    const repo = await repoWithOrigin('github-authoritative');
    const project = h.store.createProject('GitHub authoritative', { repos: [repo], remote: 'pr' });
    const connection = h.store.upsertGitConnection({ organizationId: project.organizationId!, provider: 'github',
      installationId: '42', accountLogin: 'acme', accountType: 'Organization' });
    const enrolled = h.store.upsertRepository({ organizationId: project.organizationId!, provider: 'github', providerId: '77',
      owner: 'acme', name: 'pipeline', sshUrl: REMOTE, defaultBranch: 'main', private: true, gitConnectionId: connection.id });
    h.store.attachProjectRepository({ projectId: project.id, repositoryId: enrolled.id });
    const task = h.store.createTask({ projectId: project.id, title: 'GitHub merge', workflow: 'software-dev',
      workflowVersion: '1.13.0', params: { prompt: 'x', _githubAccountId: 'a-github' },
      createdBy: { kind: 'user', userId: 'a' } });
    const taskId = task.id;
    const handle = await h.client.workflow.start('softwareDev@1.13.0', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [{
        taskId, projectId: project.id, title: 'GitHub merge', prompt: '@write proposal.md :: reviewed proposal\n@review Ready',
        base: 'main', target: 'main', project: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', remote: 'pr' },
      }],
    });

    await expect.poll(async () => {
      const current = await view(handle);
      return `${current.stage}/${current.prs?.length ?? 0}`;
    }, { timeout: 30_000 }).toBe('review/1');
    expect(prs[0].state).toBe('open');
    await handle.signal('confirm');
    expect(await handle.result()).toMatchObject({ stage: 'done', sha: 'github-merge-sha' });
    expect(prs[0].state).toBe('closed');
    const final = await view(handle);
    expect(final.pr).toMatchObject({ merged: true, state: 'closed', headSha: 'reviewed-head' });
    expect(final.transcripts.some((transcript: any) => transcript.role === 'merge')).toBe(false);
    expect(final.messages.map((message: any) => message.text).join('\n')).toMatch(/Open PR was refused: the proposal has uncommitted changes/i);
    // GitHub, not a local installation-token push, is authoritative: the local
    // bare origin's target is intentionally untouched by this stub merge.
    const origin = path.join(originDir, 'github-authoritative.git');
    expect((await git(origin, ['show', 'main:proposal.md'])).code).not.toBe(0);
  }, 120_000);

  it('v1.14 returns terminal CI failures to Do with failed-check context, then reviews the repaired head again', async () => {
    const repo = await repoWithOrigin('github-ci-repair');
    const project = h.store.createProject('GitHub CI repair', { repos: [repo], remote: 'pr' });
    const connection = h.store.upsertGitConnection({ organizationId: project.organizationId!, provider: 'github',
      installationId: '43', accountLogin: 'acme', accountType: 'Organization' });
    const enrolled = h.store.upsertRepository({ organizationId: project.organizationId!, provider: 'github', providerId: '78',
      owner: 'acme', name: 'pipeline', sshUrl: REMOTE, defaultBranch: 'main', private: true, gitConnectionId: connection.id });
    h.store.attachProjectRepository({ projectId: project.id, repositoryId: enrolled.id });
    const task = h.store.createTask({ projectId: project.id, title: 'Repair failing CI', workflow: 'software-dev',
      workflowVersion: '1.14.0', params: { prompt: 'x', _githubAccountId: 'a-github' },
      createdBy: { kind: 'user', userId: 'a' } });
    const handle = await h.client.workflow.start('softwareDev@1.14.0', {
      taskQueue: TASK_QUEUE,
      workflowId: task.id,
      args: [{
        taskId: task.id, projectId: project.id, title: 'Repair failing CI',
        prompt: '@write ci.md :: tested proposal\n@review Ready for CI', base: 'main', target: 'main',
        project: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', remote: 'pr' },
        githubPollMs: 10,
      }],
    });

    await expect.poll(async () => (await view(handle)).stage, { timeout: 30_000 }).toBe('review');
    githubReadiness = {
      mergeStateStatus: 'UNSTABLE',
      statusCheckRollup: { state: 'FAILURE', contexts: { nodes: [{
        __typename: 'CheckRun', name: 'unit tests', status: 'COMPLETED', conclusion: 'FAILURE',
        detailsUrl: 'https://github.test/checks/ci-repair', output: { summary: 'expected green, received red' },
      }] } },
    };
    await handle.signal('confirm');

    await expect.poll(async () => {
      const current = await view(handle);
      const context = current.messages.map((message: any) => message.text).join('\n');
      return `${current.stage}/${/unit tests.*ci-repair.*expected green/is.test(context)}`;
    }, { timeout: 30_000 }).toBe('review/true');
    githubReadiness = {};
    await handle.signal('confirm');
    expect(await handle.result()).toMatchObject({ stage: 'done', sha: 'github-merge-sha' });
  }, 120_000);

  it('v1.16 preserves intent authorization and automatically reviews a CI repair before landing', async () => {
    const repo = await repoWithOrigin('github-intent-repair');
    const project = h.store.createProject('Intent-authorized CI repair', { repos: [repo], remote: 'pr' });
    const connection = h.store.upsertGitConnection({ organizationId: project.organizationId!, provider: 'github',
      installationId: '53', accountLogin: 'acme', accountType: 'Organization' });
    const enrolled = h.store.upsertRepository({ organizationId: project.organizationId!, provider: 'github', providerId: '88',
      owner: 'acme', name: 'pipeline', sshUrl: REMOTE, defaultBranch: 'main', private: true, gitConnectionId: connection.id });
    h.store.attachProjectRepository({ projectId: project.id, repositoryId: enrolled.id });
    const task = h.store.createTask({ projectId: project.id, title: 'Repair without human churn', workflow: 'software-dev',
      workflowVersion: '1.16.0', params: { prompt: 'x', _githubAccountId: 'a-github' },
      createdBy: { kind: 'user', userId: 'a' } });
    const handle = await h.client.workflow.start('softwareDev@1.16.0', {
      taskQueue: TASK_QUEUE,
      workflowId: task.id,
      args: [{
        taskId: task.id, projectId: project.id, title: 'Repair without human churn',
        prompt: '@write intent.md :: repaired proposal\n@review Ready for intent review',
        base: 'main', target: 'main',
        project: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', remote: 'pr' },
        githubPollMs: 10,
      }],
    });

    await expect.poll(async () => (await view(handle)).stage, { timeout: 30_000 }).toBe('review');
    githubReadiness = {
      mergeStateStatus: 'UNSTABLE',
      statusCheckRollup: { state: 'FAILURE', contexts: { nodes: [{
        __typename: 'CheckRun', name: 'integration tests', status: 'COMPLETED', conclusion: 'FAILURE',
        detailsUrl: 'https://github.test/checks/intent-repair', output: { summary: 'base interaction failed' },
      }] } },
    };
    await handle.signal('confirm');

    await expect.poll(async () => {
      const current = await view(handle);
      return JSON.stringify({
        stage: current.stage,
        status: current.status,
        waitingFor: current.waitingFor,
        landing: current.landing,
        lastMessage: current.messages.at(-1)?.text,
      });
    }, { timeout: 30_000 }).toContain('"stage":"done"');
    expect(await handle.result()).toMatchObject({ stage: 'done', sha: 'reviewed-head' });
    const final = await view(handle);
    expect(final.landing).toMatchObject({ authorization: 'authorized', validation: 'passed', provider: 'none' });
    expect(final.transcripts.find((transcript: any) => transcript.role === 'confirm')?.messages
      .some((message: any) => message.text.includes('AUTOMATED INTEGRATION-REPAIR review'))).toBe(true);
    expect(final.messages.map((message: any) => message.text).join('\n')).toMatch(/intent authorization is preserved/i);
  }, 120_000);

  it('v1.16 releases the krmax admission queue after GitHub accepts durable queue ownership', async () => {
    const repo = await repoWithOrigin('github-provider-queue');
    const project = h.store.createProject('Provider-owned queue', { repos: [repo], remote: 'pr' });
    const connection = h.store.upsertGitConnection({ organizationId: project.organizationId!, provider: 'github',
      installationId: '54', accountLogin: 'acme', accountType: 'Organization' });
    const enrolled = h.store.upsertRepository({ organizationId: project.organizationId!, provider: 'github', providerId: '89',
      owner: 'acme', name: 'pipeline', sshUrl: REMOTE, defaultBranch: 'main', private: true, gitConnectionId: connection.id });
    h.store.attachProjectRepository({ projectId: project.id, repositoryId: enrolled.id });
    const task = h.store.createTask({ projectId: project.id, title: 'Queue without blocking', workflow: 'software-dev',
      workflowVersion: '1.16.0', params: { prompt: 'x', _githubAccountId: 'a-github' },
      createdBy: { kind: 'user', userId: 'a' } });
    useMergeQueue = true;
    const handle = await h.client.workflow.start('softwareDev@1.16.0', {
      taskQueue: TASK_QUEUE,
      workflowId: task.id,
      args: [{
        taskId: task.id, projectId: project.id, title: 'Queue without blocking',
        prompt: '@write queued.md :: provider queue\n@review Ready', base: 'main', target: 'main',
        project: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', remote: 'pr' },
        githubPollMs: 50,
      }],
    });

    await expect.poll(async () => (await view(handle)).stage, { timeout: 30_000 }).toBe('review');
    await handle.signal('confirm');
    await expect.poll(async () => {
      const current = await view(handle);
      return `${current.stage}/${current.waitingFor?.kind}/${current.landing?.provider}`
        + `/${current.mergeQueue === undefined}/${current.state.mergeDomains === undefined}/${current.state.mergeDomain === undefined}`;
    }, { timeout: 30_000 }).toMatch(/merge\/github\/(queued|validating)\/true\/true\/true/);
    await handle.signal('cancel');
    await expect(handle.result()).resolves.toMatchObject({ stage: 'cancelled' });
  }, 120_000);

  it('unsticks a v1.12 execution when GitHub reports a conflict only in the merge refusal', async () => {
    const repo = await repoWithOrigin('github-legacy-conflict');
    const project = h.store.createProject('Legacy GitHub conflict', { repos: [repo], remote: 'pr' });
    const connection = h.store.upsertGitConnection({ organizationId: project.organizationId!, provider: 'github',
      installationId: '45', accountLogin: 'acme', accountType: 'Organization' });
    const enrolled = h.store.upsertRepository({ organizationId: project.organizationId!, provider: 'github', providerId: '80',
      owner: 'acme', name: 'pipeline', sshUrl: REMOTE, defaultBranch: 'main', private: true, gitConnectionId: connection.id });
    h.store.attachProjectRepository({ projectId: project.id, repositoryId: enrolled.id });
    const task = h.store.createTask({ projectId: project.id, title: 'Unstick legacy conflict', workflow: 'software-dev',
      workflowVersion: '1.12.0', params: { prompt: 'x', _githubAccountId: 'a-github' },
      createdBy: { kind: 'user', userId: 'a' } });
    const handle = await h.client.workflow.start('softwareDev@1.12.0', {
      taskQueue: TASK_QUEUE,
      workflowId: task.id,
      args: [{
        taskId: task.id, projectId: project.id, title: 'Unstick legacy conflict',
        prompt: '@write legacy-conflict.md :: repaired proposal\n@review Ready', base: 'main', target: 'main',
        project: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', remote: 'pr' },
      }],
    });

    await expect.poll(async () => (await view(handle)).stage, { timeout: 30_000 }).toBe('review');
    githubReadiness = { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' };
    mergeHttpStatus = 409;
    mergeFailureMessage = 'Pull Request has merge conflicts';
    await handle.signal('confirm');

    await expect.poll(async () => {
      const current = await view(handle);
      const context = current.messages.map((message: any) => message.text).join('\n');
      return `${current.stage}/${/merge conflicts.*Finish the Do turn/is.test(context)}`;
    }, { timeout: 30_000 }).toBe('review/true');

    githubReadiness = {};
    mergeHttpStatus = undefined;
    mergeFailureMessage = undefined;
    await handle.signal('confirm');
    expect(await handle.result()).toMatchObject({ stage: 'done', sha: 'github-merge-sha' });
  }, 120_000);

  it('v1.14 bounds transient GitHub errors and lets a Merge wait follow-up return to Do', async () => {
    const repo = await repoWithOrigin('github-error-recovery');
    const project = h.store.createProject('GitHub error recovery', { repos: [repo], remote: 'pr' });
    const connection = h.store.upsertGitConnection({ organizationId: project.organizationId!, provider: 'github',
      installationId: '44', accountLogin: 'acme', accountType: 'Organization' });
    const enrolled = h.store.upsertRepository({ organizationId: project.organizationId!, provider: 'github', providerId: '79',
      owner: 'acme', name: 'pipeline', sshUrl: REMOTE, defaultBranch: 'main', private: true, gitConnectionId: connection.id });
    h.store.attachProjectRepository({ projectId: project.id, repositoryId: enrolled.id });
    const task = h.store.createTask({ projectId: project.id, title: 'Recover GitHub', workflow: 'software-dev',
      workflowVersion: '1.14.0', params: { prompt: 'x', _githubAccountId: 'a-github' },
      createdBy: { kind: 'user', userId: 'a' } });
    const handle = await h.client.workflow.start('softwareDev@1.14.0', {
      taskQueue: TASK_QUEUE,
      workflowId: task.id,
      args: [{
        taskId: task.id, projectId: project.id, title: 'Recover GitHub',
        prompt: '@write retry.md :: retry proposal\n@review Ready', base: 'main', target: 'main',
        project: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', remote: 'pr' },
        githubPollMs: 10,
      }],
    });

    await expect.poll(async () => (await view(handle)).stage, { timeout: 30_000 }).toBe('review');
    mergeHttpStatus = 503;
    await handle.signal('confirm');
    await expect.poll(async () => {
      const current = await view(handle);
      return `${current.stage}/${current.status}/${current.waitingFor?.kind}/${current.actions.map((action: any) => action.name).join(',')}`;
    }, { timeout: 30_000 }).toMatch(/merge\/waiting\/human\/.*followUp/);

    mergeHttpStatus = undefined;
    await handle.signal('followUp', { id: 'repair-github', role: 'user', text: 'Retry from Do after the GitHub outage.', ts: Date.now() }, 'do');
    await expect.poll(async () => {
      const current = await view(handle);
      return `${current.stage}/${current.messages.some((message: any) => message.text.includes('Retry from Do'))}`;
    }, { timeout: 30_000 }).toBe('review/true');
    await handle.signal('confirm');
    expect(await handle.result()).toMatchObject({ stage: 'done' });
  }, 120_000);

  /** Task 419 was already pinned to 1.10.0 when branch-before-PR shipped. Its
   *  recorded workflow must remain replay-compatible, but a newly fixed activity
   *  can let its empty PR stage be a no-op; the historical Merge stage then does
   *  exactly what it always did: commit the dirty result and land it safely. */
  it('lets a pinned 1.10 workflow with uncommitted work continue past its empty PR stage', async () => {
    const repo = await repoWithOrigin('pinned-1-10');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev@1.10.0', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [{
        taskId,
        projectId: 'p1',
        title: 'Historical dirty branch',
        prompt: '@write historical.md :: preserved by Merge\n@review Added historical.md',
        base: 'main',
        target: 'main',
        project: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', remote: 'pr' },
      }],
    });

    await expect.poll(async () => (await view(handle)).stage, { timeout: 30_000 }).toBe('review');
    await handle.signal('confirm');
    expect((await handle.result()).stage).toBe('done');

    expect(prs).toHaveLength(0); // this historical pin cannot add a post-Merge PR command
    const origin = path.join(originDir, 'pinned-1-10.git');
    expect((await git(origin, ['show', 'main:historical.md'])).stdout).toContain('preserved by Merge');
    const final = await view(handle);
    const merge = final.transcripts.find((transcript: any) => transcript.role === 'merge');
    expect(merge.messages.map((message: any) => message.text).join('\n')).toMatch(/commit any work that should land/i);
  }, 120_000);

  it('pushes a post-PR conflict resolution back to the pull-request branch before landing it', async () => {
    const repo = await repoWithOrigin('post-pr-conflict');
    fs.writeFileSync(path.join(repo, 'conflict.txt'), 'base\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-q', '-m', 'add conflict base']);
    await git(repo, ['push', '-q', 'origin', 'main']);

    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev@1.11.0', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [{
        taskId,
        projectId: 'p1',
        title: 'Resolve after PR',
        prompt: '@write conflict.txt :: task version\n@review Changed conflict.txt',
        base: 'main',
        target: 'main',
        project: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', remote: 'pr' },
      }],
    });

    await expect.poll(async () => (await view(handle)).stage, { timeout: 30_000 }).toBe('review');
    // Race the target immediately after GitHub accepts the initial PR. The first
    // protected landing now conflicts, so the Merge agent must resolve it after
    // the PR already exists.
    afterPrOpened = async () => {
      fs.writeFileSync(path.join(repo, 'conflict.txt'), 'target version\n');
      await git(repo, ['add', '-A']);
      await git(repo, ['commit', '-q', '-m', 'race target after PR']);
    };
    await handle.signal('confirm');
    expect((await handle.result()).stage).toBe('done');

    const origin = path.join(originDir, 'post-pr-conflict.git');
    expect((await git(origin, ['show', `karmax/${taskId}:conflict.txt`])).stdout)
      .toBe('resolved after PR\n');
    expect((await git(origin, ['show', 'main:conflict.txt'])).stdout)
      .toBe('resolved after PR\n');
    const merge = (await view(handle)).transcripts.find((transcript: any) => transcript.role === 'merge');
    expect(merge.messages.map((message: any) => message.text).join('\n')).toContain('unresolved conflicts');
  }, 120_000);

  /** Workflow versions are pinned per execution (SPEC §5.1): a task started
   *  before the PR lifecycle existed keeps running the behavior it recorded, so
   *  the reconcile/close steps must be gated by version, not by policy alone. */
  it('leaves the PR untouched after the merge for an execution pinned to 1.7.0', async () => {
    const repo = await repoWithOrigin('legacy');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev@1.7.0', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [{
        taskId,
        projectId: 'p1',
        title: 'Legacy',
        prompt: 'Implement it.\n@write legacy.js :: export const l = 1;\n'
          + '@run git add -A && git commit -q -m "add legacy.js"\n@review Added legacy.js',
        base: 'main',
        target: 'main',
        project: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', remote: 'pr' },
      }],
    });
    await expect.poll(async () => (await view(handle)).stage, { timeout: 30_000 }).toBe('review');
    await handle.signal('confirm');
    expect((await handle.result()).stage).toBe('done');

    // The PR still opens — that half of the stage is version-independent.
    expect(prs).toHaveLength(1);
    expect(prs[0].head.ref).toBe(`karmax/${taskId}`);
    // …but nothing reconciles it, exactly as this version's history recorded.
    expect(prs[0].state).toBe('open');
    expect(comments).toEqual([]);
  }, 120_000);
});
