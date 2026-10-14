import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootHarness, type Harness } from './helpers/harness.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import { git } from '../src/world/git.js';
import { newId } from '../src/util/id.js';

/**
 * Several branches per task (SPEC §11.1): the agent may open a pull request for
 * one branch while it keeps working (`open_pr` with `branch`). That branch
 * becomes its own sub-task, reviewed and landed on its own timing; the task is
 * done once its agent has finished AND every pull request it opened has landed.
 *
 * Real Temporal + git, mock agent. `@ship <name>` is `open_pr({ branch: name })`.
 */
describe('software-dev: shipping branches of a multi-branch task on their own', () => {
  let h: Harness;
  beforeAll(async () => { h = await bootHarness(); }, 60_000);
  afterAll(async () => { await h?.stop(); });

  const view = (handle: { query: (name: string) => Promise<unknown> }) => handle.query('view') as Promise<any>;
  const start = (taskId: string, repo: string, prompt: string) => h.client.workflow.start('softwareDev@1.30.0', {
    taskQueue: TASK_QUEUE,
    workflowId: taskId,
    args: [{
      taskId, projectId: 'p1', title: 'Docs and a feature', prompt, base: 'main', target: 'main',
      project: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false, multiPr: true },
    }],
  });
  const shippedChild = async (handle: any) => {
    await expect.poll(async () => (await view(handle)).subTasks?.length ?? 0, { timeout: 30_000 }).toBe(1);
    const childId = (await view(handle)).subTasks[0] as string;
    return { childId, child: h.client.workflow.getHandle(childId) };
  };
  // Commit the docs branch, as an agent must before it can open its pull request.
  const docsCommit = "@run cd ../docs && mkdir -p docs && echo '# Guide' > docs/guide.md && git add -A && git commit -qm docs";

  it('a branch lands on its own while the agent keeps working, then the agent opens the rest', async () => {
    const repo = await h.makeRepo('ship-while-working');
    const gate = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ship-gate-')), 'go');
    const taskId = newId('task');
    const handle = await start(taskId, repo, [
      '@branch docs',
      docsCommit,
      '@ship docs',
      // The agent keeps working in the same turn while the docs PR is reviewed.
      `@run while [ ! -f ${gate} ]; do sleep 0.2; done`,
      '@write feature.js :: export const feature = 1;',
      '@run git add -A && git commit -qm feature',
    ].join('\n'));

    try {
      const { childId, child } = await shippedChild(handle);
      // The shipped branch is its own task: its own branch, landing on main, at
      // Review — a person's, not the parent agent's.
      await expect.poll(async () => { const v = await view(child); return `${v.stage}/${v.waitingFor?.kind}`; },
        { timeout: 30_000 }).toBe('review/human');
      const childView = await view(child);
      expect(childView.branch).toBe(`tavya/${childId}`);
      expect(childView.targetBranch).toBe('main');
      expect(childView.parentTaskId).toBe(taskId);

      // The parent is still working, and has handed the branch off.
      const parentWorking = await view(handle);
      expect(parentWorking.stage).toBe('do');
      expect(parentWorking.agentTurn?.state).toBe('running');
      expect(parentWorking.checkouts?.map((c: any) => c.name) ?? []).not.toContain('docs');
      expect(parentWorking.shipments).toEqual([expect.objectContaining({ checkout: 'docs', childTaskId: childId })]);

      // The reviewer approves the docs PR; it lands while the agent still works.
      await child.signal('confirm');
      expect((await child.result()).stage).toBe('done');
      expect((await git(repo, ['show', 'main:docs/guide.md'])).stdout).toContain('# Guide');
      expect((await git(repo, ['log', '--oneline', 'main'])).stdout).toContain(`merge tavya/${childId} into main`);
      expect((await view(handle)).agentTurn?.state).toBe('running');
      expect((await git(repo, ['show', 'main:feature.js'])).code).not.toBe(0);

      // The agent finishes; the rest of its work goes through the task's own Review.
      fs.writeFileSync(gate, '');
      await expect.poll(async () => (await view(handle)).stage, { timeout: 30_000 }).toBe('review');
      await handle.signal('confirm');
      expect((await handle.result()).stage).toBe('done');
      expect((await git(repo, ['show', 'main:feature.js'])).stdout).toContain('feature');
      expect((await view(handle)).shipments).toEqual([expect.objectContaining({ checkout: 'docs', state: 'landed' })]);
    } finally { fs.writeFileSync(gate, ''); }
  }, 150_000);

  it('the final proposal does not wait for an earlier PR, but Done does', async () => {
    const repo = await h.makeRepo('ship-done-waits');
    const taskId = newId('task');
    const handle = await start(taskId, repo, [
      '@branch docs',
      docsCommit,
      '@ship docs',
      '@write feature.js :: export const feature = 1;',
      '@run git add -A && git commit -qm feature',
    ].join('\n'));
    const { child } = await shippedChild(handle);

    // Both proposals are in Review at once: neither waits for the other.
    await expect.poll(async () => (await view(child)).waitingFor?.kind, { timeout: 30_000 }).toBe('human');
    await expect.poll(async () => (await view(handle)).waitingFor?.kind, { timeout: 30_000 }).toBe('human');
    expect((await view(child)).stage).toBe('review');
    expect((await view(handle)).stage).toBe('review');

    // The task's own PR lands first; the task is not done while the docs PR is open.
    await handle.signal('confirm');
    await expect.poll(async () => (await git(repo, ['show', 'main:feature.js'])).code, { timeout: 30_000 }).toBe(0);
    await expect.poll(async () => (await view(handle)).waitingFor?.kind, { timeout: 30_000 }).toBe('subtask');
    expect((await view(handle)).status).not.toBe('done');

    await child.signal('confirm');
    expect((await handle.result()).stage).toBe('done');
    expect((await git(repo, ['show', 'main:docs/guide.md'])).code).toBe(0);
  }, 150_000);

  it('with everything already shipped, finishing needs no Review of its own', async () => {
    const repo = await h.makeRepo('ship-everything');
    const taskId = newId('task');
    const handle = await start(taskId, repo, ['@branch docs', docsCommit, '@ship docs'].join('\n'));
    const { child } = await shippedChild(handle);
    await expect.poll(async () => (await view(child)).stage, { timeout: 30_000 }).toBe('review');
    // The agent finished with nothing left to propose: it waits for its PR, not for a reviewer.
    await expect.poll(async () => (await view(handle)).waitingFor?.kind, { timeout: 30_000 }).toBe('subtask');
    expect((await view(handle)).stage).not.toBe('review');

    await child.signal('confirm');
    expect((await handle.result()).stage).toBe('done');
    expect((await git(repo, ['log', '--oneline', 'main'])).stdout).not.toContain(`merge tavya/${taskId} into main`);
  }, 120_000);

  it('a reviewer\'s change request is made in the shipped branch, which then lands', async () => {
    const repo = await h.makeRepo('ship-revise');
    const taskId = newId('task');
    const handle = await start(taskId, repo, ['@branch docs', docsCommit, '@ship docs', '@incomplete'].join('\n'));
    const { child } = await shippedChild(handle);
    await expect.poll(async () => (await view(child)).waitingFor?.kind, { timeout: 30_000 }).toBe('human');

    // The reviewer asks for more; the shipped branch's own agent works in a
    // world holding exactly that branch, and proposes it again.
    await child.signal('followUp', { id: 'rv1', role: 'user', ts: 0, text: [
      '@run test -f docs/guide.md && echo HAS-GUIDE',
      '@write docs/faq.md :: # FAQ',
      '@run git add -A && git commit -qm faq',
    ].join('\n') });
    await expect.poll(async () => (await view(child)).messages.some((m: any) => m.role === 'agent' && m.text.includes('ran: test -f docs/guide.md')),
      { timeout: 30_000 }).toBe(true);
    await expect.poll(async () => { const v = await view(child); return `${v.stage}/${v.waitingFor?.kind}`; },
      { timeout: 30_000 }).toBe('review/human');
    expect((await h.store.eventsOfType((await view(child)).taskId, 'agent.output'))
      .some((event) => String(event.payload.text).includes('HAS-GUIDE'))).toBe(true);
    await child.signal('confirm');
    expect((await child.result()).stage).toBe('done');
    expect((await git(repo, ['show', 'main:docs/faq.md'])).code).toBe(0);
    expect((await git(repo, ['show', 'main:docs/guide.md'])).code).toBe(0);

    // The managing task hears that its pull request landed at its next turn.
    await handle.signal('followUp', { id: 'f1', role: 'user', ts: 0, text: 'Anything left?\n@incomplete' });
    await expect.poll(async () => (await view(handle)).messages.some((m: any) => m.role === 'user'
      && /The pull request for "docs" .* landed on main/.test(m.text)), { timeout: 30_000 }).toBe(true);
    await handle.signal('cancel');
    await handle.result();
  }, 150_000);

  it('refuses what cannot land on its own, and tells the agent why', async () => {
    const repo = await h.makeRepo('ship-refusals');
    const taskId = newId('task');
    const handle = await start(taskId, repo, [
      '@branch docs',
      '@run cd ../docs && echo draft > draft.md',
      '@ship docs',                      // uncommitted work
      '@branch empty',
      '@ship empty',                     // nothing to propose
      `@ship ${path.basename(repo)}`,    // the task's own branch lands with the task
      '@ship nope',                      // no such branch
      '@incomplete',
    ].join('\n'));
    await expect.poll(async () => (await view(handle)).waitingFor?.kind, { timeout: 30_000 }).toBe('human');
    const said = (await view(handle)).messages.filter((m: any) => m.role === 'agent').map((m: any) => m.text).join('\n');
    expect(said).toMatch(/ship refused: .*docs.*uncommitted/i);
    expect(said).toMatch(/ship refused: .*empty.*no commits/i);
    expect(said).toMatch(/ship refused: .*lands with this task/i);
    expect(said).toMatch(/ship refused: .*no branch named "nope"/i);
    expect((await view(handle)).subTasks ?? []).toHaveLength(0);
    await handle.signal('cancel');
    await handle.result();
  }, 90_000);
});
