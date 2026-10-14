import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootHarness, type Harness } from './helpers/harness.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import { git } from '../src/world/git.js';

/**
 * Several branches per task (SPEC §11.1): ONE agent in ONE world, a checkout
 * per branch, and every branch landing as its own pull request on its own
 * timing. `open_pr({branch})` opens (or updates) one branch's pull request
 * while the agent keeps working; `open_pr` alone means it is finished. Each pull
 * request is a sub-task that reviews and lands a snapshot of the branch from a
 * worktree in the task's world — no second sandbox, no second agent: changes a
 * pull request needs come back to the one agent. The task is done once its
 * agent has finished and every pull request has settled.
 *
 * Real Temporal + git, mock agent. `@ship <name>` is `open_pr({ branch: name })`.
 */
describe('software-dev: every branch of a task lands as its own pull request', () => {
  let h: Harness;
  beforeAll(async () => { h = await bootHarness(); }, 60_000);
  afterAll(async () => { await h?.stop(); });

  const view = (handle: { query: (name: string) => Promise<unknown> }) => handle.query('view') as Promise<any>;
  /** A task of a real project, so its pull requests are made and routed from records as in the product. */
  const start = async (repo: string, prompt: string) => {
    const config = { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false, multiPr: true };
    const project = await h.store.createProject(`Ship ${path.basename(repo)}`, config);
    const task = await h.store.createTask({ projectId: project.id, title: 'Docs and a feature', workflow: 'software-dev',
      workflowVersion: '1.30.0', params: { prompt, multiPr: true }, createdBy: { kind: 'user', userId: 'a' } });
    const handle = await h.client.workflow.start('softwareDev@1.30.0', {
      taskQueue: TASK_QUEUE,
      workflowId: task.id,
      args: [{ taskId: task.id, projectId: project.id, title: task.title, prompt, base: 'main', target: 'main', project: config }],
    });
    return { taskId: task.id, handle };
  };
  /** The task's `n`th pull request, once it waits for a person's Review. */
  const pullRequest = async (handle: any, n: number) => {
    await expect.poll(async () => (await view(handle)).subTasks?.length ?? 0, { timeout: 30_000 }).toBeGreaterThanOrEqual(n);
    const childId = (await view(handle)).subTasks[n - 1] as string;
    const child = h.client.workflow.getHandle(childId);
    await expect.poll(async () => { const v = await view(child); return `${v.stage}/${v.waitingFor?.kind}`; },
      { timeout: 30_000 }).toBe('review/human');
    return { childId, child };
  };
  const said = async (handle: any) => (await view(handle)).messages
    .filter((m: any) => m.role === 'agent').map((m: any) => m.text).join('\n');
  // Commit to the docs branch, as an agent must before its pull request opens.
  const docsCommit = "@run cd ../docs && mkdir -p docs && echo '# Guide' > docs/guide.md && git add -A && git commit -qm docs";

  it('one agent, one world: a pull request lands while the agent keeps working, then its last one', async () => {
    const repo = await h.makeRepo('ship-while-working');
    const gate = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ship-gate-')), 'go');
    const { taskId, handle } = await start(repo, [
      '@branch docs',
      docsCommit,
      '@ship docs',
      // The agent keeps working in the same turn while the docs pull request is reviewed.
      `@run while [ ! -f ${gate} ]; do sleep 0.2; done`,
      '@write feature.js :: export const feature = 1;',
      '@run git add -A && git commit -qm feature',
    ].join('\n'));
    try {
      const { childId, child } = await pullRequest(handle, 1);
      const pr = await view(child);
      expect(pr.branch).toBe(`tavya/${childId}`);
      expect(pr.targetBranch).toBe('main');
      expect(pr.parentTaskId).toBe(taskId);
      // It lands from a worktree in the task's own world: no world of its own.
      expect(pr.world.id).toBe(taskId);
      expect(pr.world.repos.map((r: any) => r.name)).toEqual(['docs']);
      expect(pr.world.repos[0].root).toContain(path.join('.karmax-injection', 'pull-requests', childId));
      expect(await h.store.currentWorld(childId)).toBeFalsy();

      // The agent is still working.
      const parent = await view(handle);
      expect(parent.stage).toBe('do');
      expect(parent.agentTurn?.state).toBe('running');
      expect(parent.shipments).toEqual([expect.objectContaining({ checkout: 'docs', childTaskId: childId, state: 'open' })]);

      // The reviewer approves it; it lands while the agent still works.
      await child.signal('confirm');
      expect((await child.result()).stage).toBe('done');
      expect((await git(repo, ['show', 'main:docs/guide.md'])).stdout).toContain('# Guide');
      // Its snapshot worktree is gone from the world; its branch stays.
      const snapshot = pr.world.repos[0].root as string;
      expect(fs.existsSync(snapshot)).toBe(false);
      expect((await git(repo, ['worktree', 'list'])).stdout).not.toContain(snapshot);
      expect((await git(repo, ['rev-parse', '--verify', `tavya/${childId}`])).code).toBe(0);
      expect(await h.store.eventsOfType(taskId, 'pull-request.cleanup-failed')).toEqual([]);
      expect((await git(repo, ['log', '--oneline', 'main'])).stdout).toContain(`merge tavya/${childId} into main`);
      expect((await view(handle)).agentTurn?.state).toBe('running');

      // The agent finishes: its other branch opens as its own pull request,
      // and the task waits for it — it never has a Review of its own.
      fs.writeFileSync(gate, '');
      const { childId: lastId, child: last } = await pullRequest(handle, 2);
      expect((await view(handle)).waitingFor?.kind).toBe('subtask');
      expect((await view(handle)).stage).toBe('do');
      await last.signal('confirm');
      expect((await handle.result()).stage).toBe('done');
      expect((await git(repo, ['show', 'main:feature.js'])).stdout).toContain('feature');
      expect((await git(repo, ['log', '--oneline', 'main'])).stdout).toContain(`merge tavya/${lastId} into main`);
      expect((await git(repo, ['log', '--oneline', 'main'])).stdout).not.toContain(`merge tavya/${taskId} into main`);
      expect((await view(handle)).shipments.map((s: any) => s.state)).toEqual(['landed', 'landed']);
      // Its branches stayed in its world throughout.
      expect((await view(handle)).checkouts.map((c: any) => c.name)).toContain('docs');
    } finally { fs.writeFileSync(gate, ''); }
  }, 150_000);

  it('a change Review asks for is made by the same agent in its own checkout, and the pull request lands with it', async () => {
    const repo = await h.makeRepo('ship-revise');
    const { taskId, handle } = await start(repo, ['@branch docs', docsCommit, '@ship docs', '@incomplete'].join('\n'));
    const { child } = await pullRequest(handle, 1);

    // The reviewer asks the pull request for more. It has no agent: the task's
    // agent gets the request, makes the change in its docs checkout and opens
    // the pull request again.
    await child.signal('followUp', { id: 'rv1', role: 'user', ts: 0, text: [
      "@run cd ../docs && echo '# FAQ' > docs/faq.md && git add -A && git commit -qm faq",
      '@ship docs',
      '@incomplete',
    ].join('\n') });
    await expect.poll(async () => (await view(handle)).messages.some((m: any) => m.role === 'user'
      && m.text.startsWith('Changes are needed in the pull request for "docs"')), { timeout: 30_000 }).toBe(true);
    await expect.poll(async () => said(handle), { timeout: 30_000 }).toMatch(/shipped: docs as /g);
    // Still one pull request, back at Review with the new commit.
    const { child: again } = await pullRequest(handle, 1);
    expect((await view(handle)).subTasks).toHaveLength(1);
    expect((await h.store.eventsOfType(taskId, 'agent.output')).some((e) => String(e.payload.text).includes('echo \'# FAQ\''))).toBe(true);
    await again.signal('confirm');
    expect((await again.result()).stage).toBe('done');
    expect((await git(repo, ['show', 'main:docs/faq.md'])).code).toBe(0);
    expect((await git(repo, ['show', 'main:docs/guide.md'])).code).toBe(0);

    // Finishing with nothing new: no more pull requests, and the task is done.
    await handle.signal('followUp', { id: 'f1', role: 'user', ts: 0, text: 'That is all.' });
    expect((await handle.result()).stage).toBe('done');
    expect((await view(handle)).subTasks).toHaveLength(1);
  }, 150_000);

  it('opening a pull request again before Review updates it; after it lands, the branch opens a new one', async () => {
    const repo = await h.makeRepo('ship-again');
    const { handle } = await start(repo, [
      '@branch docs',
      docsCommit,
      '@ship docs',
      "@run cd ../docs && echo more >> docs/guide.md && git commit -qam more",
      '@ship docs',
      '@incomplete',
    ].join('\n'));
    await expect.poll(async () => said(handle), { timeout: 30_000 }).toMatch(/shipped: docs as .*\n.*\n.*shipped: docs as /);
    expect((await view(handle)).subTasks).toHaveLength(1);
    // Review is of the commit the agent opened it at last.
    const docsBranch = (await view(handle)).checkouts.find((c: any) => c.name === 'docs').branch;
    const head = (await git(repo, ['rev-parse', docsBranch])).stdout.trim();
    await expect.poll(async () => (await h.store.eventsOfType((await view(handle)).taskId, 'pull-request.snapshot'))
      .some((event) => (event.payload as any).head === head), { timeout: 30_000 }).toBe(true);
    const { child } = await pullRequest(handle, 1);
    await child.signal('confirm');
    expect((await child.result()).stage).toBe('done');
    expect((await git(repo, ['show', 'main:docs/guide.md'])).stdout).toContain('more');

    // Later in the same session the agent adds to the branch: it must take in
    // what landed first, and then it is a new pull request.
    await handle.signal('followUp', { id: 'f1', role: 'user', ts: 0, text: [
      "@run cd ../docs && echo faq > faq.md && git add -A && git commit -qm faq",
      '@ship docs',
      '@incomplete',
    ].join('\n') });
    await expect.poll(async () => said(handle), { timeout: 30_000 }).toMatch(/ship refused: bring "docs" up to date with main/);
    await handle.signal('followUp', { id: 'f2', role: 'user', ts: 0, text: [
      '@run cd ../docs && git merge -q --no-edit main',
      '@ship docs',
      '@incomplete',
    ].join('\n') });
    const { child: second } = await pullRequest(handle, 2);
    await second.signal('confirm');
    expect((await second.result()).stage).toBe('done');
    expect((await git(repo, ['show', 'main:faq.md'])).code).toBe(0);
    await handle.signal('cancel');
    await handle.result();
  }, 150_000);

  it('a pull request closed without landing leaves the world, and its branch is not proposed again unchanged', async () => {
    const repo = await h.makeRepo('ship-cancelled');
    const { taskId, handle } = await start(repo, ['@branch docs', docsCommit, '@ship docs', '@incomplete'].join('\n'));
    const { childId, child } = await pullRequest(handle, 1);
    const snapshot = (await view(child)).world.repos[0].root as string;
    expect(fs.existsSync(snapshot)).toBe(true);
    await child.signal('cancel');
    expect((await child.result()).stage).toBe('cancelled');
    expect(fs.existsSync(snapshot)).toBe(false);
    expect((await git(repo, ['worktree', 'list'])).stdout).not.toContain(snapshot);
    expect(await h.store.eventsOfType(taskId, 'pull-request.cleanup-failed')).toEqual([]);
    // The agent is told; when it finishes, the unchanged branch is not reopened.
    await expect.poll(async () => (await view(handle)).messages.some((m: any) => m.role === 'user'
      && m.text.includes(`(sub-task ${childId}) closed without landing`)), { timeout: 30_000 }).toBe(true);
    expect((await handle.result()).stage).toBe('done');
    expect((await view(handle)).subTasks).toHaveLength(1);
    expect((await git(repo, ['show', 'main:docs/guide.md'])).code).not.toBe(0);
  }, 120_000);

  it('Finish replaces Cancel once something landed: the task ends done and what did not land is closed', async () => {
    const repo = await h.makeRepo('ship-finish');
    const { handle } = await start(repo, ['@branch docs', docsCommit, '@ship docs', '@incomplete'].join('\n'));
    const { child: docs } = await pullRequest(handle, 1);
    const actions = async () => ((await view(handle)).actions as any[]).map((action) => action.name);
    expect(await actions()).toContain('cancel');
    expect(await actions()).not.toContain('finish');
    await docs.signal('confirm');
    expect((await docs.result()).stage).toBe('done');
    await expect.poll(actions, { timeout: 30_000 }).toContain('finish');
    expect(await actions()).not.toContain('cancel');

    // More work goes up for review, then the person finishes the task instead.
    await handle.signal('followUp', { id: 'f1', role: 'user', ts: 0, text: [
      '@branch api',
      "@run cd ../api && echo 'export const api = 1;' > api.js && git add -A && git commit -qm api",
      '@ship api',
      '@incomplete',
    ].join('\n') });
    const { child: api } = await pullRequest(handle, 2);
    const snapshot = (await view(api)).world.repos[0].root as string;
    await handle.signal('finish');
    expect((await handle.result()).stage).toBe('done');
    expect((await view(handle)).status).toBe('done');
    expect((await api.result()).stage).toBe('cancelled');
    expect(fs.existsSync(snapshot)).toBe(false);
    expect((await git(repo, ['show', 'main:docs/guide.md'])).code).toBe(0);
    expect((await git(repo, ['show', 'main:api.js'])).code).not.toBe(0);
    expect((await view(handle)).reviewInfo?.summary).toMatch(/Landed: "docs"\. Closed without landing: "api"\./);
  }, 150_000);

  it('Done waits for every pull request, whichever lands first', async () => {
    const repo = await h.makeRepo('ship-done-waits');
    const { handle } = await start(repo, [
      '@branch docs',
      docsCommit,
      '@ship docs',
      '@write feature.js :: export const feature = 1;',
      '@run git add -A && git commit -qm feature',
    ].join('\n'));
    const { child: docs } = await pullRequest(handle, 1);
    const { child: feature } = await pullRequest(handle, 2);
    await feature.signal('confirm');
    expect((await feature.result()).stage).toBe('done');
    await expect.poll(async () => (await view(handle)).waitingFor?.kind, { timeout: 30_000 }).toBe('subtask');
    expect((await view(handle)).status).not.toBe('done');
    await docs.signal('confirm');
    expect((await handle.result()).stage).toBe('done');
    expect((await git(repo, ['show', 'main:docs/guide.md'])).code).toBe(0);
    expect((await git(repo, ['show', 'main:feature.js'])).code).toBe(0);
  }, 150_000);

  it('refuses what cannot open, and tells the agent why', async () => {
    const repo = await h.makeRepo('ship-refusals');
    const { handle } = await start(repo, [
      '@branch docs',
      '@run cd ../docs && echo draft > draft.md',
      '@ship docs',                      // uncommitted work
      '@branch empty',
      '@ship empty',                     // nothing to propose
      '@ship nope',                      // no such branch
      '@incomplete',
    ].join('\n'));
    await expect.poll(async () => (await view(handle)).waitingFor?.kind, { timeout: 30_000 }).toBe('human');
    const text = await said(handle);
    expect(text).toMatch(/ship refused: .*docs.*uncommitted/i);
    expect(text).toMatch(/ship refused: .*empty.*no commits/i);
    expect(text).toMatch(/ship refused: .*no branch named "nope"/i);
    expect((await view(handle)).subTasks ?? []).toHaveLength(0);
    await handle.signal('cancel');
    await handle.result();
  }, 90_000);
});
