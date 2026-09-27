import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { bootHarness, type Harness } from './helpers/harness.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import { newId } from '../src/util/id.js';
import { temporal } from '@temporalio/proto';

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
        // Restart while the task is idle in its sign-in wait, as in production.
        // Restarting mid workflow task abandons that task, and Temporal only
        // reschedules it after its 10 s workflow-task timeout: a CI flake.
        await expect.poll(async () => (await handle.fetchHistory()).events?.at(-1)?.eventType, { timeout: 25_000 })
          .toBe(temporal.api.enums.v1.EventType.EVENT_TYPE_TIMER_STARTED);
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
  }
});
