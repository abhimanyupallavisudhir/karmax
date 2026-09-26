import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootHarness, Harness } from './helpers/harness.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import { accountCoordinatorId } from '../src/coordinators/names.js';
import { newId } from '../src/util/id.js';
import { MockAdapter } from '../src/agent/mock.js';
import { ProviderPolicyFailure } from '../src/agent/limits.js';

/**
 * End-to-end park→refresh→resume at the WORKFLOW layer (RESOLVE-PLAN §2): a real
 * softwareDev task whose only compatible login is exhausted PARKS ("waiting for a
 * login"), runs no agent while parked, and RESUMES to completion the moment the
 * login is made available. Uses the mock agent → ZERO real quota.
 */
describe('quota park → resume (software-dev task, mock agent)', () => {
  let h: Harness;
  beforeAll(async () => {
    const mock = new MockAdapter();
    h = await bootHarness('mock', {
      provider: 'mock',
      async runTurn(input, ctx) {
        if (input.role === 'do' && input.messages.some(message => message.text.includes('@policy-fixture'))) {
          throw new ProviderPolicyFailure({ code: 'misalignmentPolicyViolation',
            message: 'HTTP 401: This request was blocked by our safety systems. Reason: Potentially unintended activity.' }, 'mock');
        }
        return mock.runTurn(input, ctx);
      },
    });
  }, 60_000);
  afterAll(async () => { await h?.stop(); });

  it('escalates a safety block once while another task can use the same account', async () => {
    const { makeCoordinatorActivities } = await import('../src/activities/coordinator.js');
    const coord = makeCoordinatorActivities({ client: h.client, taskQueue: TASK_QUEUE });
    await coord.registerAccounts([{ id: 'mock:policy', configHome: '/tmp/mock-policy', provider: 'mock', maxConcurrent: 1 }]);
    const cw = h.client.workflow.getHandle(accountCoordinatorId());
    const repo = await h.makeRepo('policy');
    const start = async (prompt: string) => {
      const taskId = newId('task');
      return h.client.workflow.start('softwareDev@1.26.0', {
        taskQueue: TASK_QUEUE, workflowId: taskId,
        args: [{ taskId, projectId: 'p1', title: 'Policy regression', prompt,
          base: 'main', target: 'main',
          project: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false } }],
      });
    };
    const blocked = await start('@policy-fixture');
    try {
      await expect.poll(async () => (await blocked.query('view') as any).stage, { timeout: 30_000 }).toBe('escalated');
      const view = await blocked.query('view') as any;
      expect(JSON.stringify(view)).toContain('Potentially unintended activity');
      const history = await blocked.fetchHistory();
      expect(history.events!.filter(e => e.activityTaskScheduledEventAttributes?.activityType?.name === 'runAgentTurn')).toHaveLength(1);
      const account = ((await cw.query('accounts')) as any).accounts.find((a: any) => a.id === 'mock:policy');
      expect(account.status).toBe('available');
      const healthy = await start('@review done');
      try {
        await expect.poll(async () => (await healthy.query('view') as any).stage, { timeout: 30_000 }).toBe('review');
      } finally { await healthy.terminate('test complete'); }
    } finally {
      await blocked.terminate('test complete');
      await cw.terminate('test complete');
    }
  });

  it('gives replacement executions distinct turn IDs without changing activity retry identity', async () => {
    const repo = await h.makeRepo('replacement-turn');
    const taskId = newId('task');
    const ids: string[] = [];
    for (let run = 0; run < 2; run++) {
      const handle = await h.client.workflow.start('softwareDev@1.26.0', {
        taskQueue: TASK_QUEUE, workflowId: taskId,
        args: [{ taskId, projectId: 'p1', title: 'Replacement turn',
          prompt: 'Do the work.\n@review done', base: 'main', target: 'main',
          project: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false } }],
      });
      await expect.poll(async () => (await handle.query('view') as any).stage, { timeout: 30_000 }).toBe('review');
      const history = await handle.fetchHistory();
      const scheduled = history.events!.find((e) => e.activityTaskScheduledEventAttributes?.activityType?.name === 'runAgentTurn')!;
      const input = JSON.parse(Buffer.from(scheduled.activityTaskScheduledEventAttributes!.input!.payloads![0]!.data!).toString());
      const { runId } = await handle.describe();
      expect(input.agentTurnId).toBe(`${taskId}:${runId}#0`);
      ids.push(input.agentTurnId);
      await handle.terminate('test replacement');
    }
    expect(new Set(ids).size).toBe(2);
  });

  it('does not publish a login wait when an account is granted immediately', async () => {
    const { makeCoordinatorActivities } = await import('../src/activities/coordinator.js');
    const coord = makeCoordinatorActivities({ client: h.client, taskQueue: TASK_QUEUE });
    await coord.registerAccounts([{ id: 'mock:ready', configHome: '/tmp/mockready', provider: 'mock', maxConcurrent: 1 }]);
    const cw = h.client.workflow.getHandle(accountCoordinatorId());
    await expect.poll(async () => ((await cw.query('accounts')) as any).accounts.length, { timeout: 10_000 }).toBe(1);

    const repo = await h.makeRepo('ready-now');
    const taskId = newId('task');
    const transitions: any[] = [];
    const stopListening = h.bus.onTask(taskId, (ev) => {
      if (ev.type === 'view.updated') transitions.push(ev.payload);
    });
    const handle = await h.client.workflow.start('softwareDev@1.5.0', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [
        {
          taskId,
          projectId: 'p1',
          title: 'Start without a false login wait',
          prompt: 'Do the work.\n@sleep 500\n@review done',
          base: 'main',
          target: 'main',
          project: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false },
        },
      ],
    });

    await expect.poll(async () => (await handle.query('view') as any).stage, { timeout: 30_000 }).toBe('review');
    expect(transitions.some((p) => p.waitingFor === 'agentSlot')).toBe(true);
    expect(transitions.some((p) =>
      p.waitingFor === 'agentSlot' && p.waitingDetail === 'Starting agent',
    )).toBe(true);
    expect(transitions.some((p) => p.waitingFor === 'account')).toBe(false);
    stopListening();

    await handle.signal('confirm');
    await handle.result();
    await cw.terminate('done').catch(() => {});
  });

  it('parks a task on an exhausted login and resumes it when the login is freed', async () => {
    const { makeCoordinatorActivities } = await import('../src/activities/coordinator.js');
    const coord = makeCoordinatorActivities({ client: h.client, taskQueue: TASK_QUEUE });
    // One mock login, marked exhausted (far-future reset so only a manual/timer
    // change frees it) — created BEFORE the task so its Do turn parks on the lease.
    await coord.registerAccounts([{ id: 'mock:only', configHome: '/tmp/mockhome', provider: 'mock', maxConcurrent: 1 }]);
    const cw = h.client.workflow.getHandle(accountCoordinatorId());
    await expect.poll(async () => ((await cw.query('accounts')) as any).accounts.length, { timeout: 10_000 }).toBe(1);
    const resetAt = Date.now() + 3_600_000;
    await cw.signal('reportExhausted', { accountId: 'mock:only', window: '5h', resetAt });

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
          prompt: 'Do the work.\n@sleep 500\n@write parked.txt :: hello\n@review done',
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
    expect(parked.waitingFor?.earliestResetAt).toBe(resetAt);
    expect(parked.waitingFor?.detail).toContain('usage limit');
    expect((parked.messages || []).some((m: any) => m.role === 'agent')).toBe(false);

    // Capture every published transition after the grant. This remains reliable even
    // when the mock turn is fast enough for a query to miss an intermediate view.
    const transitions: any[] = [];
    const stopListening = h.bus.onTask(taskId, (ev) => {
      if (ev.type === 'view.updated') transitions.push(ev.payload);
    });

    // Free the login → the workflow must publish the distinct host-slot state
    // immediately, then the activity reports running only after admission.
    await cw.signal('setAccountAvailability', { accountId: 'mock:only', status: 'available' });
    await expect.poll(() => transitions.some((p) => p.waitingFor === 'agentSlot' && p.agentTurn === 'waiting-slot'), { timeout: 20_000 }).toBe(true);
    await expect.poll(() => transitions.some((p) => p.waitingFor === null && p.agentTurn === 'running'), { timeout: 20_000 }).toBe(true);
    const slotAt = transitions.findIndex((p) => p.agentTurn === 'waiting-slot');
    const runningAt = transitions.findIndex((p) => p.agentTurn === 'running');
    expect(slotAt).toBeGreaterThanOrEqual(0);
    expect(runningAt).toBeGreaterThan(slotAt);
    stopListening();

    await expect.poll(async () => (await view()).stage, { timeout: 30_000 }).toBe('review');
    expect((await view()).messages.some((m: any) => m.role === 'agent')).toBe(true);

    await handle.signal('confirm');
    const r = await handle.result();
    expect(r.stage).toBe('done');
    await cw.terminate('done').catch(() => {});
  });
});
