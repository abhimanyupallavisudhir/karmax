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
        // The query answers from workflow memory before the wait is durably
        // published and the world parked. Restarting mid-way strands that work until
        // its timeout (parkWaitingWorld heartbeats every 30 s) and stalls the task
        // past the limit below (task 389's CI flake). Restart once nothing is in flight.
        await expect.poll(async () => {
          const { raw } = await handle.describe();
          return !raw.pendingWorkflowTask && !(raw.pendingActivities?.length);
        }, { timeout: 25_000 }).toBe(true);
        await h.restartWorker();
        expect((await view()).stage).toBe('do');
        (await h.store.kvSet(`service-connection:${taskId}`, JSON.stringify({ id: taskId, taskId, status: 'active', notifiedAt: Date.now() })));
        await handle.signal('followUp', { id: 'connected', role: 'user', text: 'Account connected. Continue.\n@openpr', ts: Date.now() }, 'do');
        await expect.poll(async () => (await view()).stage, { timeout: 25_000 }).toBe('review');
      } finally { await handle.signal('cancel'); await handle.result().catch(() => {}); }
    }, 90_000);
  }
});
