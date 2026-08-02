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
      state: 'open', merged_at: null, title: body.title, body: body.body,
      head: { ref: body.head }, base: { ref: body.base } };
    prs.push(pr);
    const hook = afterPrOpened;
    afterPrOpened = undefined;
    await hook?.();
    return json(201, pr);
  }
  const one = u.pathname.match(new RegExp(`^/repos/${SLUG}/pulls/(\\d+)$`));
  if (one) {
    const pr = prs.find((candidate) => candidate.number === Number(one[1]));
    if (!pr) return json(404, {});
    if (method === 'PATCH') Object.assign(pr, body);
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
    h = await bootHarness('mock', adapter, { githubPr: { apiBase: 'https://api.github.test', fetch: fetcher } });
    originDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-pr-origin-'));
  }, 120_000);
  afterAll(async () => {
    delete process.env.GH_TOKEN;
    await h?.stop();
    fs.rmSync(originDir, { recursive: true, force: true });
  });
  beforeEach(() => { prs.length = 0; comments.length = 0; afterPrOpened = undefined; });

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
