import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { bootHarness, type Harness } from './helpers/harness.js';
import { TASK_QUEUE } from '../src/temporal/config.js';

/**
 * A permanent co-ordinator (wiki features/coordinator) end to end: real
 * Temporal + git, mock agent. It never finishes: open_pr opens a pull request
 * per branch with new work and the task goes on; and whenever it stops — a
 * turn asking nothing, waiting on its sub-tasks, a failure — it is woken again
 * within its interval. Tests shorten an interval minute with `waitMinuteMs`.
 */
describe('software-dev: a permanent co-ordinator', () => {
  let h: Harness;
  beforeAll(async () => { h = await bootHarness(); }, 60_000);
  afterAll(async () => { await h?.stop(); });

  const view = (handle: { query: (name: string) => Promise<unknown> }) => handle.query('view') as Promise<any>;
  /** `wakeHours` × 60 minutes of `waitMinuteMs` each. */
  const start = async (name: string, prompt: string, opts: { wakeHours: number; waitMinuteMs?: number; resolveAgentEnabled?: boolean }) => {
    const repo = await h.makeRepo(name);
    const config = { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false, multiPr: true };
    const project = await h.store.createProject(`Firm ${path.basename(repo)}`, config);
    const coordinator = { wakeHours: opts.wakeHours };
    const task = await h.store.createTask({ projectId: project.id, title: 'Run the firm', workflow: 'software-dev',
      workflowVersion: '1.30.0', params: { prompt, coordinator }, createdBy: { kind: 'user', userId: 'a' } });
    const handle = await h.client.workflow.start('softwareDev@1.30.0', {
      taskQueue: TASK_QUEUE,
      workflowId: task.id,
      args: [{ taskId: task.id, projectId: project.id, title: task.title, prompt, base: 'main', target: 'main', project: config,
        coordinator, ...(opts.waitMinuteMs ? { waitMinuteMs: opts.waitMinuteMs } : {}),
        ...(opts.resolveAgentEnabled === false ? { resolveAgentEnabled: false } : {}) }],
    });
    return { taskId: task.id, handle };
  };
  const checkIns = async (handle: any) => (await view(handle)).messages
    .filter((m: any) => m.role === 'user' && String(m.text).startsWith('(Check-in:')).length;

  it('rests after a turn that asks nothing, asking nobody, and checks in when its interval runs out', async () => {
    // One minute of 4 s: it rests 4 s.
    const { taskId, handle } = await start('coordinator-rest', '@say Planned the week.', { wakeHours: 1 / 60, waitMinuteMs: 4_000 });
    try {
      await expect.poll(async () => { const v = await view(handle); return `${v.stage}/${v.status}/${v.waitingFor?.kind}`; },
        { timeout: 30_000, interval: 100 }).toBe('do/waiting/timer');
      const resting = await view(handle);
      expect(resting.waitingFor).toMatchObject({ summary: 'Checks in', detail: 'Checks in again within 1 minute' });
      expect(resting.waitingFor.until).toBeGreaterThan(Date.now());
      // Nobody is asked: it is not waiting on a person.
      expect((await h.store.eventsOfType(taskId, 'view.updated')).some((e: any) => e.payload.waitingFor === 'human')).toBe(false);
      // Its interval ran out: it is woken with a check-in, takes a turn, and rests again.
      await expect.poll(() => checkIns(handle), { timeout: 30_000, interval: 200 }).toBeGreaterThanOrEqual(1);
      await expect.poll(async () => (await view(handle)).messages.filter((m: any) => m.role === 'agent').length,
        { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
      expect((await view(handle)).stage).toBe('do');
    } finally {
      await handle.signal('cancel');
      expect((await handle.result()).stage).toBe('cancelled');
    }
  }, 120_000);

  it('opens a pull request for every branch with new work on open_pr, and goes on instead of finishing', async () => {
    const { handle } = await start('coordinator-open-pr', [
      '@write feature.js :: export const feature = 1;',
      '@run git add -A && git commit -qm feature',
      '@openpr',
    ].join('\n'), { wakeHours: 24 });
    try {
      // The branch is a pull request of its own, waiting for its Review…
      await expect.poll(async () => (await view(handle)).subTasks?.length ?? 0, { timeout: 60_000 }).toBe(1);
      const child = h.client.workflow.getHandle((await view(handle)).subTasks[0] as string);
      await expect.poll(async () => { const v = await view(child); return `${v.stage}/${v.waitingFor?.kind}`; },
        { timeout: 60_000 }).toBe('review/human');
      // …while the task itself never went to Review: it rests in Do until its next check-in.
      await expect.poll(async () => { const v = await view(handle); return `${v.stage}/${v.status}/${v.waitingFor?.kind}`; },
        { timeout: 30_000 }).toBe('do/waiting/timer');
      expect((await h.store.eventsOfType((await view(handle)).taskId, 'view.updated')).some((e: any) => e.payload.stage === 'review')).toBe(false);
    } finally {
      await handle.signal('cancel');
      await handle.result();
    }
  }, 180_000);

  it('still checks in while it waits on its sub-tasks', async () => {
    const { handle } = await start('coordinator-subtasks', '@subtask Long job :: @sleep 600000', { wakeHours: 1 / 60, waitMinuteMs: 5_000 });
    try {
      await expect.poll(async () => (await view(handle)).waitingFor?.kind, { timeout: 60_000, interval: 200 }).toBe('subtask');
      await expect.poll(() => checkIns(handle), { timeout: 60_000, interval: 250 }).toBeGreaterThanOrEqual(1);
    } finally {
      await handle.signal('cancel');
      await handle.result();
    }
  }, 180_000);

  it('retries on its own within its interval after a failure', async () => {
    const { taskId, handle } = await start('coordinator-failure', '@fail the market moved', { wakeHours: 1 / 60, waitMinuteMs: 4_000, resolveAgentEnabled: false });
    try {
      await expect.poll(async () => (await view(handle)).status, { timeout: 60_000, interval: 200 }).toBe('blocked');
      // Nobody pressed Retry: it ran the stage again, and failed again.
      await expect.poll(async () => {
        const statuses = (await h.store.eventsOfType(taskId, 'view.updated')).map((e: any) => e.payload.status);
        const first = statuses.indexOf('blocked');
        return first >= 0 && statuses.slice(first).includes('active') && statuses.lastIndexOf('blocked') > statuses.indexOf('active', first);
      }, { timeout: 60_000, interval: 250 }).toBe(true);
    } finally {
      await handle.signal('cancel');
      await handle.result();
    }
  }, 180_000);
});
