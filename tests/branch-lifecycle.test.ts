import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Harness } from './helpers/harness.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import { git } from '../src/world/git.js';
import { newId } from '../src/util/id.js';
import { bootHarness } from './helpers/harness.js';
import { MockAdapter } from '../src/agent/mock.js';
import type { AgentAdapter } from '../src/agent/types.js';
import { view } from './helpers/pipeline-harness.js';

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
  beforeAll(async () => {
    const mock = new MockAdapter();
    // The mock agent, except that told its proposal was refused it stops there
    // instead of proposing again — what decides whether the task may finish.
    const adapter: AgentAdapter = {
      provider: 'mock',
      async runTurn(input, ctx) {
        const latest = input.messages.filter((m) => m.role === 'user').at(-1)?.text ?? '';
        if (input.role === 'do' && latest.startsWith('There is no branch named'))
          return mock.runTurn({ ...input, messages: [...input.messages, { id: `stop-${input.messages.length}`, role: 'user', text: '@incomplete', ts: 0 }] }, ctx);
        return mock.runTurn(input, ctx);
      },
    };
    h = await bootHarness('mock', adapter);
  }, 60_000);
  afterAll(() => h?.stop());

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
    expect(proposed.messages.some((m: any) => m.text.startsWith('Proposed for Review: docs'))).toBe(true);
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
    expect(landed.messages.some((m: any) => m.text.startsWith('Landed: docs'))).toBe(true);
    await expect.poll(async () => (await view(handle)).actions.map((a: any) => a.name), { timeout: 30_000 }).toContain('finish');
    expect((await view(handle)).actions.map((a: any) => a.name)).not.toContain('cancel');

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
    const reviewed = (await branch(handle, 'docs')).proposedHead;

    // The reviewer approves docs while the agent is committing to it again.
    await handle.signal('followUp', { id: 'f1', role: 'user', ts: 0,
      text: '@run cd ../docs && echo more >> DOCS.md && git commit -qam more\n@sleep 1500' });
    await expect.poll(async () => (await view(handle)).agentTurn?.state ?? (await view(handle)).status, { timeout: 30_000 }).toBe('running');
    await handle.signal('approveCheckout', { name: 'docs' });

    // The approval was of the head the reviewer saw; the new one goes back to Review.
    await expect.poll(async () => (await view(handle)).status, { timeout: 30_000 }).toBe('waiting');
    const docs = await branch(handle, 'docs');
    expect(docs.state).toBe('review');
    expect(docs.proposedHead).not.toBe(reviewed);
    expect(docs.approved).toBe(false);
    expect(await onMain(repo, 'DOCS.md')).toBe(false);
    expect((await view(handle)).messages.some((m: any) => /docs changed after it was proposed/.test(m.text))).toBe(true);
    await handle.signal('cancel');
    expect((await handle.result()).stage).toBe('cancelled');
  }, 120_000);

  it('keeps every branch\'s state when the task continues as new between turns', async () => {
    // A continued run reads its conversation back from the task's stored view.
    const repo = await h.makeRepo('continued');
    const project = await h.store.createProject('Continued', { repos: [repo], multiPr: true });
    const task = await h.store.createTask({ projectId: project.id, title: 'Continued', workflow: 'software-dev',
      workflowVersion: '1.30.0', params: { prompt: 'x' }, createdBy: { kind: 'user', userId: 'a' } });
    const taskId = task.id;
    const first = await h.client.workflow.start(VERSION, {
      taskQueue: TASK_QUEUE, workflowId: taskId,
      args: [{
        taskId, projectId: project.id, title: 'Continued', prompt: `${SPLIT}@openpr docs`, base: 'main', target: 'main',
        continueAfterEvents: 80,
        project: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false, multiPr: true },
      }],
    });
    const handle = h.client.workflow.getHandle(taskId);
    const loaded = async () => { for (;;) { try { return await view(handle); } catch { await new Promise((r) => setTimeout(r, 100)); } } };
    const branch = async (_handle: any, name: string) => (await loaded()).checkouts?.find((c: any) => c.name === name);
    await expect.poll(async () => (await branch(handle, 'docs'))?.state, { timeout: 30_000 }).toBe('review');
    await expect.poll(async () => (await loaded()).status, { timeout: 30_000 }).toBe('waiting');
    const proposedIn = (await handle.describe()).runId;
    await handle.signal('approveCheckout', { name: 'docs' });
    await expect.poll(async () => (await branch(handle, 'docs'))?.state, { timeout: 30_000 }).toBe('landed');
    await expect.poll(async () => (await loaded()).status, { timeout: 30_000 }).toBe('waiting');
    await handle.signal('followUp', { id: 'f1', role: 'user', text: '@openpr', ts: 0 });
    await expect.poll(async () => (await loaded()).stage, { timeout: 30_000 }).toBe('review');
    expect((await branch(handle, 'docs'))?.state).toBe('landed');
    await handle.signal('confirm');
    expect((await handle.result()).stage).toBe('done');
    // It continued as new after docs was proposed, and docs's state came along.
    expect((await handle.describe()).runId).not.toBe(first.firstExecutionRunId);
    expect((await handle.describe()).runId).not.toBe(proposedIn);
    expect(await onMain(repo, 'DOCS.md')).toBe(true);
    expect(await onMain(repo, 'core.js')).toBe(true);
  }, 120_000);

  it('a final proposal that is refused does not finish the task', async () => {
    const { repo, handle } = await start(`${SPLIT}@openpr ghost :: final`);
    await expect.poll(async () => (await view(handle)).messages.some((m: any) => m.text.startsWith('There is no branch named ghost')),
      { timeout: 30_000 }).toBe(true);
    await expect.poll(async () => (await view(handle)).status, { timeout: 30_000 }).toBe('waiting');
    const parked = await view(handle);
    expect(parked.stage).toBe('do');
    expect(parked.checkouts.every((c: any) => c.state === 'working')).toBe(true);
    expect(await onMain(repo, 'core.js')).toBe(false);
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
