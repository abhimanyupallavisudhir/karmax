import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootHarness, Harness } from './helpers/harness.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import { accountCoordinatorId } from '../src/coordinators/names.js';
import { newId } from '../src/util/id.js';

/**
 * End-to-end park→refresh→resume at the WORKFLOW layer (RESOLVE-PLAN §2): a real
 * softwareDev task whose only compatible login is exhausted PARKS ("waiting for a
 * login"), runs no agent while parked, and RESUMES to completion the moment the
 * login is made available. Uses the mock agent → ZERO real quota.
 */
describe('quota park → resume (software-dev task, mock agent)', () => {
  let h: Harness;
  beforeAll(async () => { h = await bootHarness('mock'); }, 60_000);
  afterAll(async () => { await h?.stop(); });

  it('parks a task on an exhausted login and resumes it when the login is freed', async () => {
    const { makeCoordinatorActivities } = await import('../src/activities/coordinator.js');
    const coord = makeCoordinatorActivities({ client: h.client, taskQueue: TASK_QUEUE });
    // One mock login, marked exhausted (far-future reset so only a manual/timer
    // change frees it) — created BEFORE the task so its Do turn parks on the lease.
    await coord.registerAccounts([{ id: 'mock:only', configHome: '/tmp/mockhome', provider: 'mock', maxConcurrent: 1 }]);
    const cw = h.client.workflow.getHandle(accountCoordinatorId());
    await expect.poll(async () => ((await cw.query('accounts')) as any).accounts.length, { timeout: 10_000 }).toBe(1);
    await cw.signal('reportExhausted', { accountId: 'mock:only', window: '5h', resetAt: Date.now() + 3_600_000 });

    const repo = await h.makeRepo('parkme');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [
        {
          taskId,
          projectId: 'p1',
          title: 'Park me',
          prompt: 'Do the work.\n@write parked.txt :: hello\n@review done',
          base: 'main',
          target: 'main',
          project: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false },
        },
      ],
    });
    const view = () => handle.query('view') as Promise<any>;

    // Parked: waiting on a login, and the Do agent has NOT run (no output) — proving
    // it parked at the lease, before spending any turn.
    await expect.poll(async () => (await view()).status, { timeout: 20_000 }).toBe('waiting');
    const parked = await view();
    expect(parked.waitingFor?.kind).toBe('account');
    expect((parked.messages || []).some((m: any) => m.role === 'agent')).toBe(false);

    // Free the login → coordinator grants → task resumes, runs the Do turn, reaches Review.
    await cw.signal('setAccountAvailability', { accountId: 'mock:only', status: 'available' });
    await expect.poll(async () => (await view()).stage, { timeout: 30_000 }).toBe('review');
    expect((await view()).messages.some((m: any) => m.role === 'agent')).toBe(true);

    await handle.signal('confirm');
    const r = await handle.result();
    expect(r.stage).toBe('done');
    await cw.terminate('done').catch(() => {});
  });
});
