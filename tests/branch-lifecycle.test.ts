import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Harness } from './helpers/harness.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import { git } from '../src/world/git.js';
import { newId } from '../src/util/id.js';
import { bootPipelineHarness, pipelineGates, stopPipelineHarness, view } from './helpers/pipeline-harness.js';

/**
 * Several branches per task (software-dev ≥1.30, SPEC §11.1): one task, one
 * world, one Do agent — and each branch has its OWN Review → landing lifecycle.
 * The agent proposes a finished branch and keeps working; a reviewer approves
 * it whenever they like; it lands at the agent's next pause; the task finishes
 * once the agent's final proposal has landed (or a person finishes it).
 *
 * Real Temporal and git; local landings (remote policy none); mock agent.
 */

const VERSION = 'softwareDev@1.30.0';

describe('several branches per task: each branch is proposed, reviewed and lands on its own', () => {
  let h: Harness;
  const gates = pipelineGates();
  beforeAll(async () => { h = await bootPipelineHarness(gates); }, 60_000);
  afterAll(() => stopPipelineHarness(h, gates));

  const start = async (prompt: string) => {
    const repo = await h.makeRepo('app');
    const taskId = newId('task');
    const handle = await h.client.workflow.start(VERSION, {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [{
        taskId, projectId: 'p1', title: 'Split the change', prompt, base: 'main', target: 'main',
        project: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false, multiPr: true },
      }],
    });
    return { repo, taskId, handle };
  };
  const branch = async (handle: any, name: string) =>
    (await view(handle)).checkouts?.find((c: any) => c.name === name);
  const onMain = async (repo: string, file: string) => (await git(repo, ['show', `main:${file}`])).code === 0;

  // The agent's cwd is the primary checkout, so a second branch is a sibling directory.
  const SPLIT = 'Split the change.\n'
    + '@write core.js :: export const core = 1;\n'
    + '@run git add -A && git commit -qm core\n'
    + '@branch docs\n'
    + "@run cd ../docs && echo '# docs' > DOCS.md && git add -A && git commit -qm docs\n";

  it('lands an approved branch while the rest stays unproposed, then finishes with the final proposal', async () => {
    const { repo, handle } = await start(`${SPLIT}@openpr docs`);

    // docs is proposed on its own; the agent was resumed to keep working, then paused.
    await expect.poll(async () => (await branch(handle, 'docs'))?.state, { timeout: 30_000 }).toBe('review');
    await expect.poll(async () => (await view(handle)).status, { timeout: 30_000 }).toBe('waiting');
    const proposed = await view(handle);
    expect(proposed.messages.some((m: any) => /^Proposed for Review: docs/.test(m.text))).toBe(true);
    const primary = proposed.checkouts.find((c: any) => c.name !== 'docs');
    expect(primary.state).toBe('working');
    expect(proposed.reviewAudience).toEqual(['@creator']);

    // Approving docs lands docs — and only docs.
    await handle.signal('approveCheckout', { name: 'docs' });
    await expect.poll(async () => (await branch(handle, 'docs'))?.state, { timeout: 30_000 }).toBe('landed');
    expect(await onMain(repo, 'DOCS.md')).toBe(true);
    expect(await onMain(repo, 'core.js')).toBe(false);
    const landed = await view(handle);
    expect(landed.status).not.toBe('done');
    expect(landed.checkouts.find((c: any) => c.name === primary.name).state).toBe('working');
    // The agent hears that it landed; part of the work is on main now, so the
    // task can no longer be cancelled — only finished.
    expect(landed.messages.some((m: any) => /^Landed: docs/.test(m.text))).toBe(true);
    await expect.poll(async () => (await view(handle)).actions.map((a: any) => a.name), { timeout: 30_000 }).toContain('finish');
    expect((await view(handle)).actions.find((a: any) => a.name === 'cancel')?.enabled).toBe(false);

    // The last proposal: everything not yet landed, final. Only the primary has work.
    await handle.signal('followUp', { id: 'f1', role: 'user', text: '@openpr', ts: 0 });
    await expect.poll(async () => (await branch(handle, primary.name))?.state, { timeout: 30_000 }).toBe('review');
    expect((await branch(handle, 'docs'))?.state).toBe('landed');
    await handle.signal('confirm');
    expect((await handle.result()).stage).toBe('done');
    expect(await onMain(repo, 'core.js')).toBe(true);
  }, 120_000);

  it('Finish ends a partly landed task, leaving the rest unlanded', async () => {
    const { repo, handle } = await start(`${SPLIT}@openpr docs`);
    await expect.poll(async () => (await branch(handle, 'docs'))?.state, { timeout: 30_000 }).toBe('review');
    await handle.signal('approveCheckout', { name: 'docs' });
    await expect.poll(async () => (await view(handle)).actions.map((a: any) => a.name), { timeout: 30_000 }).toContain('finish');
    await handle.signal('finish');
    expect((await handle.result()).stage).toBe('done');
    expect(await onMain(repo, 'DOCS.md')).toBe(true);
    expect(await onMain(repo, 'core.js')).toBe(false);
  }, 120_000);

  it('a branch changed after it was proposed is not landed by an approval of the old head', async () => {
    const { repo, handle } = await start(`${SPLIT}@openpr docs`);
    await expect.poll(async () => (await branch(handle, 'docs'))?.state, { timeout: 30_000 }).toBe('review');
    await expect.poll(async () => (await view(handle)).status, { timeout: 30_000 }).toBe('waiting');

    // The agent commits to docs again before anyone approves it.
    await handle.signal('followUp', { id: 'f1', role: 'user', ts: 0,
      text: "@run cd ../docs && echo more >> DOCS.md && git commit -qam more\n@incomplete" });
    await expect.poll(async () => (await branch(handle, 'docs'))?.state, { timeout: 30_000 }).toBe('working');
    // An approval now has nothing proposed to bind to.
    await handle.signal('approveCheckout', { name: 'docs' });
    await expect.poll(async () => (await view(handle)).status, { timeout: 30_000 }).toBe('waiting');
    expect((await branch(handle, 'docs'))?.state).toBe('working');
    expect(await onMain(repo, 'DOCS.md')).toBe(false);
    expect((await view(handle)).messages.some((m: any) => /docs changed after it was proposed/.test(m.text))).toBe(true);
    await handle.signal('cancel');
    expect((await handle.result()).stage).toBe('cancelled');
  }, 120_000);

  it('a final proposal approved at once lands and finishes without another turn', async () => {
    // No Review layer: proposals are approved as they are made (as in Goal mode).
    const repo = await h.makeRepo('auto');
    const taskId = newId('task');
    const handle = await h.client.workflow.start(VERSION, {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [{
        taskId, projectId: 'p1', title: 'Auto', prompt: `${SPLIT}@openpr docs\n@openpr :: final`, base: 'main', target: 'main',
        confirm: { mode: 'auto' },
        project: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false, multiPr: true },
      }],
    });
    expect((await handle.result()).stage).toBe('done');
    expect(await onMain(repo, 'DOCS.md')).toBe(true);
    expect(await onMain(repo, 'core.js')).toBe(true);
    const finished = await view(handle);
    expect(finished.checkouts.every((c: any) => c.state === 'landed')).toBe(true);
  }, 120_000);
});
