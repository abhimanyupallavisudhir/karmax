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
import { mergeQueueId } from '../src/coordinators/names.js';
import { mergeQueueDomains } from '../src/domain/types.js';
import { GithubActionsApi } from '../src/integrations/github-actions.js';

/** The PR stage end to end under remote policy 'pr' (SPEC §5.2): the workflow
 *  opens the pull request, carries it on the view, and reconciles it with the
 *  merge outcome. Real Temporal + git; GitHub is a stub endpoint. */

const SLUG = 'acme/pipeline';
const REMOTE = `git@github.com:${SLUG}.git`;
const prs: any[] = [];
const comments: { number: number; body: string }[] = [];
let afterPrOpened: (() => Promise<void>) | undefined;
let githubReadiness: Record<string, unknown> = {};
const githubReadinessBySlug = new Map<string, Record<string, unknown>>();
let mergeHttpStatus: number | undefined;
let useMergeQueue = false;
let mergeQueueAccepted = false;
const nativeQueueSlugs = new Set<string>();
const remoteBySlug = new Map<string, string>();
const providerWithdrawals: string[] = [];
let mergeFailureMessage: string | undefined;
let originDir: string;
let blockFrontHeldRepair = false;
let frontHeldRepairStarted = false;
let releaseFrontHeldRepair: (() => void) | undefined;
let frontHeldRepairGate: Promise<void> = Promise.resolve();
const exactCandidateTurns: { role: string; session?: string; messages: string[] }[] = [];
let exactCandidateRevisions = 0;
let actionsRunAttempt = 1;
let actionsReruns = 0;
let actionsRunConclusion = 'failure';
let actionsJobConclusion = 'timed_out';
let actionsJobLog = 'Error: The hosted runner lost communication with the server\n';
let actionsReplacementSuccess = false;
let actionsInspectionForbidden = false;

async function remoteForBranch(branch: string, slug?: string): Promise<string | undefined> {
  if (slug && remoteBySlug.has(slug)) return remoteBySlug.get(slug);
  if (!originDir || !fs.existsSync(originDir)) return undefined;
  for (const entry of fs.readdirSync(originDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith('.git')) continue;
    const remote = path.join(originDir, entry.name);
    if ((await git(remote, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`])).code === 0) return remote;
  }
  return undefined;
}

async function refreshPrHead(pr: any): Promise<void> {
  const remote = await remoteForBranch(pr.head.ref, pr.repo);
  if (!remote) return;
  const head = await git(remote, ['rev-parse', '--verify', `refs/heads/${pr.head.ref}^{commit}`]);
  if (head.code === 0) pr.head.sha = head.stdout.trim();
}

async function landProviderTarget(pr: any, target: string): Promise<string> {
  await refreshPrHead(pr);
  const remote = await remoteForBranch(pr.head.ref, pr.repo);
  if (!remote) throw new Error(`stub GitHub could not find remote branch ${pr.head.ref}`);
  await gitOrThrow(remote, ['update-ref', `refs/heads/${target}`, pr.head.sha]);
  pr.merge_commit_sha = pr.head.sha;
  return pr.head.sha;
}

const fetcher = (async (url: string, init: RequestInit = {}) => {
  const u = new URL(String(url));
  const method = init.method ?? 'GET';
  const body = init.body ? JSON.parse(String(init.body)) : {};
  const json = (status: number, value: unknown) =>
    new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  if (actionsInspectionForbidden && u.pathname.startsWith(`/repos/${SLUG}/actions/`) && method === 'GET')
    return json(403, { message: 'Resource not accessible by integration' });
  if (u.pathname === `/repos/${SLUG}/actions/runs/42` && method === 'GET') return json(200, {
    id: 42, name: 'CI', workflow_id: 7, run_number: 1, run_attempt: actionsRunAttempt,
    event: 'pull_request', status: 'completed', conclusion: actionsRunConclusion, head_branch: prs[0]?.head?.ref,
    head_sha: prs[0]?.head?.sha, html_url: `https://github.com/${SLUG}/actions/runs/42`,
    created_at: '2026-08-10T00:00:00Z', updated_at: '2026-08-10T00:01:00Z',
  });
  if (u.pathname === `/repos/${SLUG}/actions/workflows/7/runs` && method === 'GET') return json(200, {
    total_count: actionsReplacementSuccess ? 2 : 1, workflow_runs: [{
      id: 42, name: 'CI', workflow_id: 7, run_number: 1, run_attempt: actionsRunAttempt,
      event: 'pull_request', status: 'completed', conclusion: actionsRunConclusion, head_branch: prs[0]?.head?.ref,
      head_sha: prs[0]?.head?.sha, html_url: `https://github.com/${SLUG}/actions/runs/42`,
      created_at: '2026-08-10T00:00:00Z', updated_at: '2026-08-10T00:01:00Z',
    }, ...(actionsReplacementSuccess ? [{
      id: 43, name: 'CI', workflow_id: 7, run_number: 2, run_attempt: 1,
      event: 'pull_request', status: 'completed', conclusion: 'success', head_branch: prs[0]?.head?.ref,
      head_sha: prs[0]?.head?.sha, html_url: `https://github.com/${SLUG}/actions/runs/43`,
      created_at: '2026-08-10T00:02:00Z', updated_at: '2026-08-10T00:03:00Z',
    }] : [])],
  });
  if (u.pathname === `/repos/${SLUG}/actions/runs/42/jobs` && method === 'GET') return json(200, { jobs: [{
    id: 99, name: 'unit tests', status: 'completed', conclusion: actionsJobConclusion,
    html_url: `https://github.com/${SLUG}/actions/runs/42/job/99`,
    steps: [{ number: 1, name: 'Run tests', status: 'completed', conclusion: actionsJobConclusion }],
  }] });
  if (u.pathname === `/repos/${SLUG}/actions/runs/42/artifacts` && method === 'GET') return json(200, { artifacts: [] });
  if (u.pathname === `/repos/${SLUG}/actions/jobs/99/logs` && method === 'GET')
    return new Response(actionsJobLog);
  if (u.pathname === `/repos/${SLUG}/actions/runs/42/rerun-failed-jobs` && method === 'POST') {
    actionsReruns++;
    return new Response(null, { status: 201 });
  }
  const list = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/pulls$/);
  if (list && method === 'GET') {
    const branch = u.searchParams.get('head')?.split(':')[1];
    const matches = prs.filter((pr) => pr.repo === list[1] && pr.head.ref === branch);
    await Promise.all(matches.map(refreshPrHead));
    return json(200, matches);
  }
  if (list && method === 'POST') {
    const pr = { repo: list[1], number: prs.length + 1, html_url: `https://github.com/${list[1]}/pull/${prs.length + 1}`,
      node_id: `PR_${prs.length + 1}`, state: 'open', merged_at: null, title: body.title, body: body.body,
      head: { ref: body.head, sha: '' }, base: { ref: body.base } };
    prs.push(pr);
    await refreshPrHead(pr);
    const hook = afterPrOpened;
    afterPrOpened = undefined;
    await hook?.();
    return json(201, pr);
  }
  if (u.pathname === '/graphql' && method === 'POST' && String(body.query).includes('PullRequestReadiness')) {
    const querySlug = `${body.variables?.owner}/${body.variables?.name}`;
    const pr = prs.find((candidate) => candidate.repo === querySlug
      && candidate.number === Number(body.variables?.number)) ?? prs[0];
    if (pr) await refreshPrHead(pr);
    return json(200, { data: { repository: { pullRequest: {
      id: pr?.node_id ?? 'PR_1', url: pr?.html_url ?? `https://github.com/${SLUG}/pull/1`,
      state: pr?.state === 'closed' ? 'CLOSED' : 'OPEN', isDraft: false, merged: Boolean(pr?.merged_at),
      headRefOid: pr?.head?.sha ?? 'reviewed-head', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
      statusCheckRollup: { state: 'SUCCESS', contexts: { nodes: [] } },
      viewerCanEnableAutoMerge: false, viewerCanMergeAsAdmin: false,
      ...(pr?.queueAccepted ? { mergeQueueEntry: { id: `MQ_${pr?.number ?? 'pipeline'}` } } : {}),
      ...githubReadiness,
      ...(pr?.repo ? githubReadinessBySlug.get(pr.repo) : undefined),
    } } } });
  }
  if (u.pathname === '/graphql' && method === 'POST' && String(body.query).includes('enqueuePullRequest')) {
    const pr = prs.find((candidate) => candidate.node_id === body.variables?.input?.pullRequestId);
    if (!useMergeQueue && !nativeQueueSlugs.has(pr?.repo))
      return json(200, { errors: [{ message: 'This branch has no merge queue' }] });
    mergeQueueAccepted = true;
    if (pr) pr.queueAccepted = true;
    return json(200, { data: { enqueuePullRequest: { mergeQueueEntry: { id: `MQ_${pr?.number ?? 'pipeline'}` } } } });
  }
  if (u.pathname === '/graphql' && method === 'POST' && String(body.query).includes('dequeuePullRequest')) {
    const pr = prs.find((candidate) => candidate.node_id === body.variables?.input?.pullRequestId);
    if (pr) pr.queueAccepted = false;
    providerWithdrawals.push(`dequeue:${body.variables?.input?.pullRequestId}`);
    return json(200, { data: { dequeuePullRequest: { mergeQueueEntry: null } } });
  }
  if (u.pathname === '/graphql' && method === 'POST' && String(body.query).includes('disablePullRequestAutoMerge')) {
    providerWithdrawals.push(`disable:${body.variables?.input?.pullRequestId}`);
    return json(200, { data: { disablePullRequestAutoMerge: { pullRequest: { id: body.variables?.input?.pullRequestId,
      autoMergeRequest: null } } } });
  }
  if (u.pathname === '/graphql' && method === 'POST') {
    return json(200, { errors: [{ message: mergeFailureMessage ?? 'GitHub did not accept the merge operation' }] });
  }
  const targetRef = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/git\/refs\/heads\/(.+)$/);
  if (targetRef && method === 'PATCH') {
    const pr = prs.find((candidate) => candidate.repo === targetRef[1] && candidate.head.sha === body.sha);
    if (!pr) return json(422, { message: 'Update is not a fast forward' });
    pr.state = 'closed'; pr.merged_at = new Date().toISOString();
    const landed = await landProviderTarget(pr, decodeURIComponent(targetRef[2]!));
    return json(200, { ref: `refs/heads/${decodeURIComponent(targetRef[2]!)}`, object: { sha: landed } });
  }
  const merge = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/merge$/);
  if (merge && method === 'PUT') {
    const pr = prs.find((candidate) => candidate.repo === merge[1] && candidate.number === Number(merge[2]));
    if (!pr) return json(404, {});
    if (useMergeQueue) return json(409, { merged: false, message: 'merge queue required' });
    if (mergeHttpStatus) return json(mergeHttpStatus, {
      merged: false,
      message: mergeFailureMessage ?? (mergeHttpStatus >= 500 ? 'GitHub merge service unavailable' : 'GitHub refused the merge'),
    });
    if (body.sha !== pr.head.sha) return json(409, { merged: false, message: 'Head branch was modified' });
    pr.state = 'closed'; pr.merged_at = new Date().toISOString();
    const landed = await landProviderTarget(pr, pr.base.ref);
    return json(200, { merged: true, sha: landed, message: 'merged' });
  }
  const one = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/);
  if (one) {
    const pr = prs.find((candidate) => candidate.repo === one[1] && candidate.number === Number(one[2]));
    if (!pr) return json(404, {});
    if (method === 'PATCH') {
      const { base, ...rest } = body;
      Object.assign(pr, rest);
      if (typeof base === 'string') pr.base = { ref: base };
    }
    await refreshPrHead(pr);
    return json(200, pr);
  }
  const comment = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/);
  if (comment && method === 'POST') {
    comments.push({ number: Number(comment[2]), body: body.body });
    return json(201, {});
  }
  return json(404, { message: `unrouted ${method} ${u.pathname}` });
}) as unknown as typeof fetch;

const view = (h: any) => h.query('view') as Promise<any>;

describe('software-dev with remote policy "pr" (real Temporal + git, stub GitHub)', () => {
  let h: Harness;
  beforeAll(async () => {
    process.env.GH_TOKEN = 'ghp_pipeline';
    originDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-pr-origin-'));
    const mock = new MockAdapter();
    const adapter: AgentAdapter = {
      provider: 'mock',
      async runTurn(input, ctx) {
        if (input.role === 'do' && blockFrontHeldRepair
          && input.messages.at(-1)?.text.includes('retains the front landing slot')) {
          frontHeldRepairStarted = true;
          await frontHeldRepairGate;
          githubReadiness = {};
        }
        if (input.role === 'confirm'
          && /(?:AUTOMATED INTEGRATION-REPAIR|FINAL AUTOMATED INTEGRATION) review/
            .test(input.messages.at(-1)?.text ?? '')) {
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
        if (input.role === 'do'
          && input.messages.at(-1)?.text.includes('FINAL AUTOMATED INTEGRATION verification')) {
          exactCandidateTurns.push({
            role: input.role,
            session: input.session,
            messages: input.messages.map((message) => message.text),
          });
          githubReadiness = {};
          const verdict = exactCandidateRevisions > 0
            ? (exactCandidateRevisions--, '@confirm revise :: Add the missing exact-candidate repair.')
            : '@confirm confirm';
          return mock.runTurn({
            ...input,
            messages: [...input.messages, {
              id: `integration-verdict-${input.messages.length}`,
              role: 'user',
              text: verdict,
              ts: input.messages.length,
            }],
          }, ctx);
        }
        if (input.role === 'do'
          && input.messages.at(-1)?.text.includes('Add the missing exact-candidate repair.')) {
          return mock.runTurn({
            ...input,
            messages: [...input.messages, {
              id: `integration-repair-${input.messages.length}`,
              role: 'user',
              text: '@write front.md :: exact candidate repaired\n@openpr',
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
        installationToken: async () => 'installation-token',
        brokerCredentials: async () => ({ env: {} }),
        actions: () => new GithubActionsApi('installation-token', { apiBase: 'https://api.github.test', fetch: fetcher }),
      } as any,
    });
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
    githubReadinessBySlug.clear();
    mergeHttpStatus = undefined;
    useMergeQueue = false;
    mergeQueueAccepted = false;
    nativeQueueSlugs.clear();
    remoteBySlug.clear();
    providerWithdrawals.length = 0;
    mergeFailureMessage = undefined;
    blockFrontHeldRepair = false;
    frontHeldRepairStarted = false;
    releaseFrontHeldRepair = undefined;
    frontHeldRepairGate = Promise.resolve();
    exactCandidateTurns.length = 0;
    exactCandidateRevisions = 0;
    actionsRunAttempt = 1;
    actionsReruns = 0;
    actionsRunConclusion = 'failure';
    actionsJobConclusion = 'timed_out';
    actionsJobLog = 'Error: The hosted runner lost communication with the server\n';
    actionsReplacementSuccess = false;
    actionsInspectionForbidden = false;
  });

  /** origin reads as GitHub (so the PR is keyed on the slug) and pushes to a
   *  local bare repo (so the push is real). */
  async function repoWithOrigin(name: string, slug = SLUG): Promise<string> {
    const repo = await h.makeRepo(name);
    const origin = path.join(originDir, `${name}.git`);
    await gitOrThrow(originDir, ['init', '-q', '--bare', '-b', 'main', origin]);
    const remoteUrl = `git@github.com:${slug}.git`;
    await git(repo, ['remote', 'add', 'origin', remoteUrl]);
    await git(repo, ['config', `url.${origin}.insteadOf`, remoteUrl]);
    await git(repo, ['push', '-q', 'origin', 'main']);
    remoteBySlug.set(slug, origin);
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
    expect(await handle.result()).toMatchObject({ stage: 'done', sha: prs[0].merge_commit_sha });
    expect(prs[0].state).toBe('closed');
    const final = await view(handle);
    expect(final.pr).toMatchObject({ merged: true, state: 'closed', headSha: prs[0].head.sha });
    expect(final.transcripts.some((transcript: any) => transcript.role === 'merge')).toBe(false);
    expect(final.messages.map((message: any) => message.text).join('\n')).toMatch(/Open PR was refused: the proposal has uncommitted changes/i);
    // GitHub is authoritative, and completion also mirrors its landed target
    // into the enrolled local checkout.
    const origin = path.join(originDir, 'github-authoritative.git');
    expect((await git(origin, ['show', 'main:proposal.md'])).stdout).toContain('reviewed proposal');
    expect((await git(repo, ['rev-parse', 'main'])).stdout.trim())
      .toBe((await git(origin, ['rev-parse', 'main'])).stdout.trim());
  }, 120_000);

  it('v1.22 restores a cancelled Review by reopening the same exact PR before Review', async () => {
    const repo = await repoWithOrigin('cancelled-review-restore');
    const project = h.store.createProject('Cancelled Review restore', { repos: [repo], remote: 'pr' });
    const connection = h.store.upsertGitConnection({ organizationId: project.organizationId!, provider: 'github',
      installationId: 'restore-installation', accountLogin: 'acme', accountType: 'Organization' });
    const enrolled = h.store.upsertRepository({ organizationId: project.organizationId!, provider: 'github',
      providerId: 'restore-repo', owner: 'acme', name: 'pipeline', sshUrl: REMOTE,
      defaultBranch: 'main', private: true, gitConnectionId: connection.id });
    h.store.attachProjectRepository({ projectId: project.id, repositoryId: enrolled.id });
    const task = h.store.createTask({
      projectId: project.id,
      title: 'Restore cancelled Review',
      workflow: 'software-dev',
      workflowVersion: '1.22.0',
      params: { prompt: 'restore it', base: 'main', target: 'main', repos: [repo], remote: 'pr', _githubAccountId: 'a-github' },
      createdBy: { kind: 'user', userId: 'a' },
    });
    const handle = await h.client.workflow.start('softwareDev@1.22.0', {
      taskQueue: TASK_QUEUE,
      workflowId: task.id,
      args: [{
        taskId: task.id,
        projectId: project.id,
        title: task.title,
        prompt: '@write restored.md :: exact proposal\n@run git add -A && git commit -q -m proposal\n@openpr',
        base: 'main', target: 'main',
        project: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', remote: 'pr' },
      }],
    });

    await expect.poll(async () => `${(await view(handle)).stage}/${(await view(handle)).prs?.length ?? 0}`,
      { timeout: 30_000 }).toBe('review/1');
    const reviewed = { number: prs[0].number, head: prs[0].head.sha };
    await handle.signal('cancel');
    expect((await handle.result()).stage).toBe('cancelled');
    expect(prs[0].state).toBe('closed');
    expect(h.store.getTask(task.id)?.lastView?.state.recoveryWorld).toBeTruthy();

    const token = h.tokens.mintPrincipal('user:a', ['*'], project.id).token;
    expect(h.store.effectiveProjectConfig(project).remote).toBe('pr');
    const restoring = await h.api.moveTaskStage(token, task.id, 'review');
    expect(restoring).toMatchObject({ stage: 'pr', state: { restoringTo: 'review' } });
    await expect.poll(() => {
      const current = h.store.getTask(task.id)?.lastView;
      return `${current?.stage}/${current?.prs?.length ?? 0}/${current?.prs?.[0]?.state}`;
    }, { timeout: 30_000 }).toBe('review/1/open');
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ number: reviewed.number, state: 'open' });
    expect(prs[0].head.sha).toBe(reviewed.head);

    await h.api.signalTask(token, task.id, 'confirm');
    await expect.poll(() => h.store.getTask(task.id)?.lastView?.stage, { timeout: 30_000 }).toBe('done');
  }, 120_000);

  it('v1.23 keeps a manually merged PR marked merged when its task is cancelled', async () => {
    const repo = await repoWithOrigin('manual-merge-before-cancel');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev@1.23.0', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [{
        taskId,
        projectId: 'p1',
        title: 'Manual merge before cancel',
        prompt: '@write manual.md :: merged on GitHub\n@run git add -A && git commit -q -m manual\n@openpr',
        base: 'main', target: 'main',
        project: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', remote: 'pr' },
      }],
    });

    await expect.poll(async () => `${(await view(handle)).stage}/${prs.length}`,
      { timeout: 30_000 }).toBe('review/1');
    prs[0].state = 'closed';
    prs[0].merged_at = new Date().toISOString();

    await handle.signal('cancel');
    await expect(handle.result()).resolves.toMatchObject({ stage: 'cancelled' });
    const final = await view(handle);
    expect(final.pr).toMatchObject({ state: 'closed', merged: true });
    expect(final.prs[0]).toMatchObject({ state: 'closed', merged: true });
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
        detailsUrl: 'https://github.test/checks/ci-repair',
      }] } },
    };
    await handle.signal('confirm');

    await expect.poll(async () => {
      const current = await view(handle);
      const context = current.messages.map((message: any) => message.text).join('\n');
      // CheckRun output text requires an additional GitHub App permission and
      // is deliberately not part of readiness. The actionable, permission-safe
      // packet is the terminal classification plus check name and details URL.
      return `${current.stage}/${/terminally failing CI.*unit tests.*ci-repair/is.test(context)}`;
    }, { timeout: 30_000 }).toBe('review/true');
    githubReadiness = {};
    await handle.signal('confirm');
    expect(await handle.result()).toMatchObject({ stage: 'done', sha: prs[0].merge_commit_sha });
  }, 120_000);

  it('reruns one transient Actions failure on the exact PR head without asking the agent to edit code', async () => {
    const repo = await repoWithOrigin('github-transient-ci');
    const project = h.store.createProject('Transient GitHub CI', { repos: [repo], remote: 'pr' });
    const connection = h.store.upsertGitConnection({ organizationId: project.organizationId!, provider: 'github',
      installationId: 'transient-actions', accountLogin: 'acme', accountType: 'Organization' });
    const enrolled = h.store.upsertRepository({ organizationId: project.organizationId!, provider: 'github', providerId: 'transient-repo',
      owner: 'acme', name: 'pipeline', sshUrl: REMOTE, defaultBranch: 'main', private: true, gitConnectionId: connection.id });
    h.store.attachProjectRepository({ projectId: project.id, repositoryId: enrolled.id });
    const task = h.store.createTask({ projectId: project.id, title: 'Retry transient CI', workflow: 'software-dev',
      workflowVersion: '1.16.0', params: { prompt: 'x', _githubAccountId: 'a-github' },
      createdBy: { kind: 'user', userId: 'a' } });
    const handle = await h.client.workflow.start('softwareDev@1.16.0', {
      taskQueue: TASK_QUEUE, workflowId: task.id, args: [{
        taskId: task.id, projectId: project.id, title: task.title,
        prompt: '@write transient.md :: no code defect\n@review Ready', base: 'main', target: 'main',
        project: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', remote: 'pr' }, githubPollMs: 25,
      }],
    });
    await expect.poll(async () => (await view(handle)).stage, { timeout: 30_000 }).toBe('review');
    githubReadiness = {
      mergeStateStatus: 'UNSTABLE',
      statusCheckRollup: { state: 'FAILURE', contexts: { nodes: [{
        __typename: 'CheckRun', name: 'unit tests', status: 'COMPLETED', conclusion: 'TIMED_OUT',
        detailsUrl: `https://github.com/${SLUG}/actions/runs/42/job/99`,
      }] } },
    };
    await handle.signal('confirm');
    await expect.poll(() => actionsReruns, { timeout: 30_000 }).toBe(1);
    await expect.poll(async () => (await view(handle)).waitingFor?.detail, { timeout: 30_000 }).toBe('Waiting for CI');
    expect(h.store.eventsSince(task.id, 0).filter((event) => event.type === 'github.ci.rerun-requested')).toHaveLength(1);
    // GitHub now reports the same exact head green. No Do repair/re-review turn
    // was needed for a provider interruption.
    githubReadiness = {};
    expect(await handle.result()).toMatchObject({ stage: 'done' });
    expect(actionsReruns).toBe(1);
  }, 120_000);

  it('accepts a successful exact-revision replacement for superseded CI without reopening the proposal', async () => {
    const repo = await repoWithOrigin('github-superseded-ci');
    const project = h.store.createProject('Superseded GitHub CI', { repos: [repo], remote: 'pr' });
    const connection = h.store.upsertGitConnection({ organizationId: project.organizationId!, provider: 'github',
      installationId: 'superseded-actions', accountLogin: 'acme', accountType: 'Organization' });
    const enrolled = h.store.upsertRepository({ organizationId: project.organizationId!, provider: 'github', providerId: 'superseded-repo',
      owner: 'acme', name: 'pipeline', sshUrl: REMOTE, defaultBranch: 'main', private: true, gitConnectionId: connection.id });
    h.store.attachProjectRepository({ projectId: project.id, repositoryId: enrolled.id });
    const task = h.store.createTask({ projectId: project.id, title: 'Ignore superseded CI', workflow: 'software-dev',
      workflowVersion: '1.16.0', params: { prompt: 'x', _githubAccountId: 'a-github' },
      createdBy: { kind: 'user', userId: 'a' } });
    const handle = await h.client.workflow.start('softwareDev@1.16.0', {
      taskQueue: TASK_QUEUE, workflowId: task.id, args: [{
        taskId: task.id, projectId: project.id, title: task.title,
        prompt: '@write superseded.md :: exact proposal\n@review Ready', base: 'main', target: 'main',
        project: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', remote: 'pr' }, githubPollMs: 25,
      }],
    });
    await expect.poll(async () => (await view(handle)).stage, { timeout: 30_000 }).toBe('review');
    actionsRunConclusion = 'cancelled';
    actionsJobConclusion = 'cancelled';
    actionsJobLog = 'Canceling since a higher priority waiting request for CI-refs/pull/106/merge exists\n';
    actionsReplacementSuccess = true;
    githubReadiness = {
      mergeStateStatus: 'CLEAN',
      statusCheckRollup: { state: 'FAILURE', contexts: { nodes: [{
        __typename: 'CheckRun', name: 'unit tests', status: 'COMPLETED', conclusion: 'CANCELLED',
        detailsUrl: `https://github.com/${SLUG}/actions/runs/42/job/99`,
      }] } },
    };
    await handle.signal('confirm');
    await expect(handle.result()).resolves.toMatchObject({ stage: 'done' });
    expect(actionsReruns).toBe(0);
    expect(h.store.eventsSince(task.id, 0).filter((event) => event.type === 'github.ci.superseded'))
      .toEqual([expect.objectContaining({ payload: expect.objectContaining({ runId: 42, supersedingRunId: 43 }) })]);
    expect((await view(handle)).messages.map((message: any) => message.text).join('\n'))
      .not.toMatch(/repair it against the newest target/i);
  }, 120_000);

  it('keeps a superseded exact-head cancellation waiting when Actions inspection is forbidden', async () => {
    const repo = await repoWithOrigin('github-actions-forbidden');
    const project = h.store.createProject('Forbidden GitHub Actions inspection', { repos: [repo], remote: 'pr' });
    const connection = h.store.upsertGitConnection({ organizationId: project.organizationId!, provider: 'github',
      installationId: 'forbidden-actions', accountLogin: 'acme', accountType: 'Organization' });
    const enrolled = h.store.upsertRepository({ organizationId: project.organizationId!, provider: 'github', providerId: 'forbidden-repo',
      owner: 'acme', name: 'pipeline', sshUrl: REMOTE, defaultBranch: 'main', private: true, gitConnectionId: connection.id });
    h.store.attachProjectRepository({ projectId: project.id, repositoryId: enrolled.id });
    const task = h.store.createTask({ projectId: project.id, title: 'Explain missing Actions access', workflow: 'software-dev',
      workflowVersion: '1.16.0', params: { prompt: 'x', _githubAccountId: 'a-github' },
      createdBy: { kind: 'user', userId: 'a' } });
    const handle = await h.client.workflow.start('softwareDev@1.16.0', {
      taskQueue: TASK_QUEUE, workflowId: task.id, args: [{
        taskId: task.id, projectId: project.id, title: task.title,
        prompt: '@write forbidden.md :: exact proposal\n@review Ready', base: 'main', target: 'main',
        project: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', remote: 'pr' }, githubPollMs: 25,
      }],
    });
    await expect.poll(async () => (await view(handle)).stage, { timeout: 30_000 }).toBe('review');
    actionsInspectionForbidden = true;
    githubReadiness = {
      mergeStateStatus: 'CLEAN',
      statusCheckRollup: { state: 'FAILURE', contexts: { nodes: [{
        __typename: 'StatusContext', context: 'unit tests', state: 'FAILURE',
        targetUrl: `https://github.com/${SLUG}/actions/runs/42/job/99`,
        description: 'Canceling since a higher priority waiting request for CI-refs/pull/106/merge exists',
      }] } },
    };
    await handle.signal('confirm');
    await expect.poll(async () => (await view(handle)).waitingFor?.detail, { timeout: 30_000 })
      .toMatch(/equivalent CI request.*waiting.*releasing its landing position/is);
    const current = await view(handle);
    expect(current.stage).toBe('merge');
    expect(current.landing?.repairAttempts ?? 0).toBe(0);
    expect(current.messages.map((message: any) => message.text).join('\n'))
      .not.toMatch(/repair it against the newest target|Grant the GitHub App/i);
    await handle.signal('cancel');
    await expect(handle.result()).resolves.toMatchObject({ stage: 'cancelled' });
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
        detailsUrl: 'https://github.test/checks/intent-repair',
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
    expect(await handle.result()).toMatchObject({ stage: 'done', sha: prs[0].merge_commit_sha });
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

  it('v1.18 keeps a repair at the front and has the same Do session verify the exact head', async () => {
    const repo = await repoWithOrigin('github-front-held-repair');
    const project = h.store.createProject('Front-held exact landing', { repos: [repo], remote: 'pr' });
    const connection = h.store.upsertGitConnection({ organizationId: project.organizationId!, provider: 'github',
      installationId: '55', accountLogin: 'acme', accountType: 'Organization' });
    const enrolled = h.store.upsertRepository({ organizationId: project.organizationId!, provider: 'github', providerId: '90',
      owner: 'acme', name: 'pipeline', sshUrl: REMOTE, defaultBranch: 'main', private: true, gitConnectionId: connection.id });
    h.store.attachProjectRepository({ projectId: project.id, repositoryId: enrolled.id });
    const task = h.store.createTask({ projectId: project.id, title: 'Repair at the front', workflow: 'software-dev',
      workflowVersion: '1.18.0', params: { prompt: 'x', _githubAccountId: 'a-github' },
      createdBy: { kind: 'user', userId: 'a' } });
    useMergeQueue = true; // The front-held protocol deliberately ignores provider queue admission.
    githubReadiness = {
      mergeStateStatus: 'UNSTABLE',
      statusCheckRollup: { state: 'FAILURE', contexts: { nodes: [{
        __typename: 'CheckRun', name: 'integration', status: 'COMPLETED', conclusion: 'FAILURE',
        detailsUrl: 'https://github.test/checks/front-held',
      }] } },
    };
    blockFrontHeldRepair = true;
    exactCandidateRevisions = 1;
    frontHeldRepairGate = new Promise<void>((resolve) => { releaseFrontHeldRepair = resolve; });
    const handle = await h.client.workflow.start('softwareDev@1.18.0', {
      taskQueue: TASK_QUEUE,
      workflowId: task.id,
      args: [{
        taskId: task.id, projectId: project.id, title: 'Repair at the front',
        prompt: '@write front.md :: exact candidate\n@review Ready', base: 'main', target: 'main',
        project: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', remote: 'pr' },
        githubPollMs: 10,
      }],
    });

    try {
      await expect.poll(async () => (await view(handle)).stage, { timeout: 30_000 }).toBe('review');
      await handle.signal('confirm');
      await expect.poll(() => frontHeldRepairStarted, { timeout: 30_000 }).toBe(true);
      const repairing = await view(handle);
      expect(repairing.stage).toBe('do');
      expect(repairing.state.mergeDomains?.length).toBeGreaterThan(0);
      for (const domain of repairing.state.mergeDomains as string[]) {
        const queue = await h.client.workflow.getHandle(mergeQueueId(domain)).query('queue') as any;
        expect(queue.current).toBe(task.id);
      }
      expect(mergeQueueAccepted).toBe(false);

      releaseFrontHeldRepair?.();
      releaseFrontHeldRepair = undefined;
      expect(await handle.result()).toMatchObject({ stage: 'done', sha: expect.any(String) });
      const final = await view(handle);
      expect(exactCandidateTurns).toHaveLength(2);
      expect(exactCandidateTurns).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'do', session: expect.stringMatching(/^mock-/) }),
      ]));
      expect(new Set(exactCandidateTurns.map((turn) => turn.session)).size).toBe(1);
      expect(final.transcripts.find((transcript: any) => transcript.role === 'do')?.messages
        .some((message: any) => message.text.includes('FINAL AUTOMATED INTEGRATION verification'))).toBe(true);
      expect(final.transcripts.find((transcript: any) => transcript.role === 'confirm')?.messages
        .some((message: any) => message.text.includes('FINAL AUTOMATED INTEGRATION verification')) ?? false).toBe(false);
      expect(final.landing).toMatchObject({ authorization: 'authorized', validation: 'passed', provider: 'none' });
      expect(mergeQueueAccepted).toBe(false);
    } finally {
      releaseFrontHeldRepair?.();
      blockFrontHeldRepair = false;
    }
  }, 120_000);

  it('v1.20 releases fallback admission before a CI repair and rejoins only after open_pr', async () => {
    const repo = await repoWithOrigin('github-fair-ejection');
    const project = h.store.createProject('Fair landing ejection', { repos: [repo], remote: 'pr' });
    const connection = h.store.upsertGitConnection({ organizationId: project.organizationId!, provider: 'github',
      installationId: '56', accountLogin: 'acme', accountType: 'Organization' });
    const enrolled = h.store.upsertRepository({ organizationId: project.organizationId!, provider: 'github', providerId: '91',
      owner: 'acme', name: 'pipeline', sshUrl: REMOTE, defaultBranch: 'main', private: true, gitConnectionId: connection.id });
    h.store.attachProjectRepository({ projectId: project.id, repositoryId: enrolled.id });
    const task = h.store.createTask({ projectId: project.id, title: 'Release failed admission', workflow: 'software-dev',
      workflowVersion: '1.20.0', params: { prompt: 'x', _githubAccountId: 'a-github' },
      createdBy: { kind: 'user', userId: 'a' } });
    const handle = await h.client.workflow.start('softwareDev@1.20.0', {
      taskQueue: TASK_QUEUE,
      workflowId: task.id,
      args: [{
        taskId: task.id, projectId: project.id, title: 'Release failed admission',
        prompt: '@write fair.md :: candidate\n@review Ready', base: 'main', target: 'main',
        project: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', remote: 'pr', landingAuthority: 'auto' },
        githubPollMs: 10,
      }],
    });

    await expect.poll(async () => (await view(handle)).stage, { timeout: 30_000 }).toBe('review');
    githubReadiness = {
      mergeStateStatus: 'UNSTABLE',
      statusCheckRollup: { state: 'FAILURE', contexts: { nodes: [{
        __typename: 'CheckRun', name: 'integration', status: 'COMPLETED', conclusion: 'FAILURE',
        detailsUrl: 'https://github.test/checks/fair',
      }] } },
    };
    await handle.signal('confirm');

    await expect.poll(async () => {
      const current = await view(handle);
      return `${current.stage}/${current.messages.at(-1)?.text ?? ''}`;
    }, { timeout: 30_000 }).toMatch(/do\/.*released every Karmax admission slot/is);
    const repairing = await view(handle);
    expect(repairing.mergeQueue).toBeUndefined();
    expect(repairing.state.mergeDomains).toBeUndefined();
    expect(repairing.landing).toMatchObject({ provider: 'ejected', validation: 'failed' });
    expect(exactCandidateTurns).toEqual([]);
    expect(mergeQueueAccepted).toBe(false);
    for (const domain of mergeQueueDomains(repairing.world, 'main', project.id)) {
      const queue = await h.client.workflow.getHandle(mergeQueueId(domain)).query('queue') as any;
      expect(queue.current).not.toBe(task.id);
      expect(queue.queue).not.toContain(task.id);
    }

    await handle.signal('cancel');
    await expect(handle.result()).resolves.toMatchObject({ stage: 'cancelled' });
  }, 120_000);

  it('v1.21 gives each repository its own landing owner and leases only the fallback target', async () => {
    const slugA = 'acme/pipeline-a';
    const slugB = 'acme/pipeline-b';
    const repoA = await repoWithOrigin('participant-a', slugA);
    const repoB = await repoWithOrigin('participant-b', slugB);
    const project = h.store.createProject('Participant landing', { repos: [repoA, repoB], remote: 'pr' });
    const connection = h.store.upsertGitConnection({ organizationId: project.organizationId!, provider: 'github',
      installationId: 'participant-installation', accountLogin: 'acme', accountType: 'Organization' });
    for (const [providerId, name, slug] of [['participant-a', 'pipeline-a', slugA], ['participant-b', 'pipeline-b', slugB]] as const) {
      const enrolled = h.store.upsertRepository({ organizationId: project.organizationId!, provider: 'github',
        providerId, owner: 'acme', name, sshUrl: `git@github.com:${slug}.git`, defaultBranch: 'main', private: true,
        gitConnectionId: connection.id });
      h.store.attachProjectRepository({ projectId: project.id, repositoryId: enrolled.id });
    }
    nativeQueueSlugs.add(slugA);
    githubReadinessBySlug.set(slugB, {
      mergeStateStatus: 'CLEAN',
      statusCheckRollup: { state: 'PENDING', contexts: { nodes: [] } },
    });
    const task = h.store.createTask({ projectId: project.id, title: 'Land two participants', workflow: 'software-dev',
      workflowVersion: '1.21.0', params: { prompt: 'x', _githubAccountId: 'a-github' },
      createdBy: { kind: 'user', userId: 'a' } });
    const nameA = path.basename(repoA);
    const nameB = path.basename(repoB);
    const handle = await h.client.workflow.start('softwareDev@1.21.0', {
      taskQueue: TASK_QUEUE,
      workflowId: task.id,
      args: [{
        taskId: task.id, projectId: project.id, title: 'Land two participants',
        prompt: `@write ${nameA}/a.md :: A\n@write ${nameB}/b.md :: B\n`
          + `@run git -C ${nameA} add -A && git -C ${nameA} commit -q -m A\n`
          + `@run git -C ${nameB} add -A && git -C ${nameB} commit -q -m B\n@openpr`,
        base: 'main', target: 'main',
        project: { repos: [repoA, repoB], defaultBase: 'main', defaultTarget: 'main', remote: 'pr', landingAuthority: 'auto' },
        githubPollMs: 10,
      }],
    });

    await expect.poll(async () => (await view(handle)).stage, { timeout: 30_000 }).toBe('review');
    await handle.signal('confirm');
    await expect.poll(async () => {
      const current = await view(handle);
      const participants = Object.values(current.landing?.participants ?? {}) as any[];
      return participants.map((candidate) => `${candidate.slug}:${candidate.owner}:${candidate.state}`).sort().join('|');
    }, { timeout: 30_000 }).toBe(`${slugA}:provider:queued|${slugB}:karmax:waiting`);
    const waiting = await view(handle);
    expect(waiting.state.mergeDomains).toEqual([`github:${slugB}:main`]);

    githubReadinessBySlug.set(slugB, {
      mergeStateStatus: 'CLEAN',
      statusCheckRollup: { state: 'SUCCESS', contexts: { nodes: [] } },
    });
    await handle.signal('providerChanged');
    await expect.poll(async () => prs.find((candidate) => candidate.repo === slugB)?.merged_at,
      { timeout: 30_000 }).toBeTruthy();

    const queuedA = prs.find((candidate) => candidate.repo === slugA)!;
    queuedA.state = 'closed';
    queuedA.merged_at = new Date().toISOString();
    queuedA.queueAccepted = false;
    await landProviderTarget(queuedA, 'main');
    await handle.signal('providerChanged');
    await expect(handle.result()).resolves.toMatchObject({ stage: 'done' });
    const final = await view(handle);
    expect(Object.values(final.landing.participants)).toEqual(expect.arrayContaining([
      expect.objectContaining({ slug: slugA, owner: 'merged', state: 'merged' }),
      expect.objectContaining({ slug: slugB, owner: 'merged', state: 'merged' }),
    ]));
    expect(final.state.mergeDomains).toBeUndefined();
  }, 120_000);

  it('v1.21 withdraws queued provider siblings before returning a failed participant to Do', async () => {
    const slugA = 'acme/withdraw-a';
    const slugB = 'acme/withdraw-b';
    const repoA = await repoWithOrigin('withdraw-a', slugA);
    const repoB = await repoWithOrigin('withdraw-b', slugB);
    const project = h.store.createProject('Withdraw siblings', { repos: [repoA, repoB], remote: 'pr' });
    const connection = h.store.upsertGitConnection({ organizationId: project.organizationId!, provider: 'github',
      installationId: 'withdraw-installation', accountLogin: 'acme', accountType: 'Organization' });
    for (const [providerId, name, slug] of [['withdraw-a', 'withdraw-a', slugA], ['withdraw-b', 'withdraw-b', slugB]] as const) {
      const enrolled = h.store.upsertRepository({ organizationId: project.organizationId!, provider: 'github', providerId,
        owner: 'acme', name, sshUrl: `git@github.com:${slug}.git`, defaultBranch: 'main', private: true,
        gitConnectionId: connection.id });
      h.store.attachProjectRepository({ projectId: project.id, repositoryId: enrolled.id });
    }
    nativeQueueSlugs.add(slugA);
    githubReadinessBySlug.set(slugB, {
      mergeStateStatus: 'CLEAN', statusCheckRollup: { state: 'PENDING', contexts: { nodes: [] } },
    });
    const task = h.store.createTask({ projectId: project.id, title: 'Withdraw siblings', workflow: 'software-dev',
      workflowVersion: '1.21.0', params: { prompt: 'x', _githubAccountId: 'a-github' },
      createdBy: { kind: 'user', userId: 'a' } });
    const nameA = path.basename(repoA);
    const nameB = path.basename(repoB);
    const handle = await h.client.workflow.start('softwareDev@1.21.0', {
      taskQueue: TASK_QUEUE, workflowId: task.id, args: [{
        taskId: task.id, projectId: project.id, title: 'Withdraw siblings',
        prompt: `@write ${nameA}/a.md :: A\n@write ${nameB}/b.md :: B\n`
          + `@run git -C ${nameA} add -A && git -C ${nameA} commit -q -m A\n`
          + `@run git -C ${nameB} add -A && git -C ${nameB} commit -q -m B\n@openpr`,
        base: 'main', target: 'main', githubPollMs: 10,
        project: { repos: [repoA, repoB], defaultBase: 'main', defaultTarget: 'main', remote: 'pr', landingAuthority: 'auto' },
      }],
    });
    await expect.poll(async () => (await view(handle)).stage, { timeout: 30_000 }).toBe('review');
    await handle.signal('confirm');
    await expect.poll(async () => Object.values((await view(handle)).landing?.participants ?? {})
      .map((candidate: any) => `${candidate.slug}:${candidate.owner}`).sort().join('|'),
    { timeout: 30_000 }).toBe(`${slugA}:provider|${slugB}:karmax`);

    githubReadinessBySlug.set(slugB, {
      mergeStateStatus: 'UNSTABLE',
      statusCheckRollup: { state: 'FAILURE', contexts: { nodes: [{
        __typename: 'StatusContext', context: 'integration', state: 'FAILURE', description: 'cross-repo contract failed',
      }] } },
    });
    await handle.signal('providerChanged');
    await expect.poll(async () => (await view(handle)).stage, { timeout: 30_000 }).toBe('do');
    expect(providerWithdrawals).toEqual(expect.arrayContaining(['dequeue:PR_1', 'disable:PR_1']));
    const repairing = await view(handle);
    expect(repairing.state.mergeDomains).toBeUndefined();
    expect(repairing.landing.participants['acme/withdraw-a#1']).toMatchObject({ owner: 'unowned', state: 'ready' });
    expect(repairing.messages.map((message: any) => message.text).join('\n')).toMatch(/cross-repo contract failed/i);
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
    expect(await handle.result()).toMatchObject({ stage: 'done', sha: prs[0].merge_commit_sha });
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
