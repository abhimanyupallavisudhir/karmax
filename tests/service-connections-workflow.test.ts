import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { bootHarness, type Harness } from './helpers/harness.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import { newId } from '../src/util/id.js';

describe('service connection workflow wait (real Temporal)', () => {
  let h: Harness;
  beforeAll(async () => { h = await bootHarness('mock'); }, 60_000);
  afterAll(async () => { await h?.stop(); });
  for (const workflow of ['justDo', 'softwareDev']) {
    it(`${workflow} waits in Do, survives a worker restart, and continues after sign-in`, async () => {
      const repo = await h.makeRepo(`connections-${workflow}`); const taskId = newId('task');
      (await h.store.kvSet(`service-connection:${taskId}`, JSON.stringify({ id: taskId, taskId, status: 'connecting' })));
      const handle = await h.client.workflow.start(workflow, { workflowId: taskId, taskQueue: TASK_QUEUE,
        args: [{ taskId, projectId: 'p1', title: 'Connect mail', prompt: '@write result.txt :: connected\n@openpr',
          base: 'main', target: 'main', project: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false } }] });
      const view = () => handle.query<any>('view');
      try {
        await expect.poll(async () => (await view()).waitingFor?.detail, { timeout: 25_000 }).toContain('Connect the requested app');
        expect((await view()).stage).toBe('do');
        // Restart while the task is idle in its sign-in wait, as in production:
        // no workflow task or activity pending. Restarting mid workflow task
        // abandons that task, and Temporal only reschedules it after its 10 s
        // workflow-task timeout: a CI flake. (A signal-driven wait need not
        // leave a timer as its last event, so the history's tail can't tell.)
        await expect.poll(async () => {
          const { raw } = await handle.describe();
          return !raw.pendingWorkflowTask && !raw.pendingActivities?.length;
        }, { timeout: 25_000 }).toBe(true);
        await h.restartWorker();
        expect((await view()).stage).toBe('do');
        (await h.store.kvSet(`service-connection:${taskId}`, JSON.stringify({ id: taskId, taskId, status: 'active', notifiedAt: Date.now() })));
        await handle.signal('followUp', { id: 'connected', role: 'user', text: 'Account connected. Continue.\n@openpr', ts: Date.now() }, 'do');
        await expect.poll(async () => (await view()).stage, { timeout: 25_000 }).toBe('review');
      } finally {
        // Bounded, so a failed assertion is reported rather than a test timeout.
        await handle.signal('cancel');
        const finished = await Promise.race([handle.result().then(() => true, () => true),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), 20_000))]);
        if (!finished) await handle.terminate('test cleanup').catch(() => {});
      }
    }, 90_000);

    it(`${workflow} is not held by an ignored request, and an Ignore releases a task waiting on it`, async () => {
      const repo = await h.makeRepo(`connections-ignored-${workflow}`); const taskId = newId('task');
      const key = `service-connection:${taskId}`;
      (await h.store.kvSet(key, JSON.stringify({ id: taskId, taskId, status: 'requested' })));
      const handle = await h.client.workflow.start(workflow, { workflowId: taskId, taskQueue: TASK_QUEUE,
        args: [{ taskId, projectId: 'p1', title: 'Connect mail', prompt: '@write result.txt :: answered',
          base: 'main', target: 'main', project: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false } }] });
      const view = () => handle.query<any>('view');
      try {
        await expect.poll(async () => (await view()).waitingFor?.detail, { timeout: 25_000 }).toContain('Connect the requested app');
        // A person ignores it (POST /api/connections/:id/dismiss): the task checks
        // its requests again (an ignored one holds nothing) and makes its own ask.
        (await h.store.kvSet(key, JSON.stringify({ id: taskId, taskId, status: 'requested', dismissed: { by: 'user:u', at: Date.now() } })));
        await handle.signal('connectionsChanged');
        // Unversioned, both reach Review at a turn's end (a current software-dev
        // parks in Do with its reply for @creator instead): either way, a
        // person is asked and the request no longer holds the task.
        await expect.poll(async () => (await view()).stage, { timeout: 25_000 }).toBe('review');
        expect((await view()).waitingFor?.detail ?? '').not.toContain('Connect the requested app');
      } finally {
        await handle.signal('cancel');
        const finished = await Promise.race([handle.result().then(() => true, () => true),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), 20_000))]);
        if (!finished) await handle.terminate('test cleanup').catch(() => {});
      }
    }, 90_000);
  }

  it('a current software-dev sends its reply to its creator once its request is ignored (LVPM #8)', async () => {
    const repo = await h.makeRepo('connections-ignored-current'); const taskId = newId('task');
    const key = `service-connection:${taskId}`;
    (await h.store.kvSet(key, JSON.stringify({ id: taskId, taskId, status: 'requested' })));
    const handle = await h.client.workflow.start('softwareDev@1.30.0', { workflowId: taskId, taskQueue: TASK_QUEUE,
      args: [{ taskId, projectId: 'p1', title: 'Connect mail', prompt: 'Here is what I found.\n@incomplete',
        base: 'main', target: 'main', project: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false } }] });
    const view = () => handle.query<any>('view');
    try {
      await expect.poll(async () => (await view()).waitingFor?.detail, { timeout: 25_000 }).toContain('Connect the requested app');
      // Parked on the request, its wait names nobody: the inbox can list it for no one.
      expect((await view()).waitingFor?.audience).toBeUndefined();
      (await h.store.kvSet(key, JSON.stringify({ id: taskId, taskId, status: 'requested', dismissed: { by: 'user:u', at: Date.now() } })));
      await handle.signal('connectionsChanged');
      await expect.poll(async () => (await view()).waitingFor?.audience ?? [], { timeout: 25_000 }).toContain('@creator');
      expect((await view()).stage).toBe('do');
      // The wait is its reply, and Open PR is offered again.
      expect((await view()).waitingFor?.detail ?? '').not.toContain('Connect the requested app');
      expect((await view()).actions.map((a: any) => a.name)).toContain('openPr');
    } finally {
      await handle.signal('cancel');
      const finished = await Promise.race([handle.result().then(() => true, () => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 20_000))]);
      if (!finished) await handle.terminate('test cleanup').catch(() => {});
    }
  }, 90_000);
});
