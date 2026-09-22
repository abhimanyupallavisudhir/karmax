import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockAdapter } from '../src/agent/mock.js';
import type { AgentAdapter } from '../src/agent/types.js';
import { agentQueueId } from '../src/coordinators/names.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import { newId } from '../src/util/id.js';
import { bootHarness, type Harness } from './helpers/harness.js';

describe('durable agent-turn admission', () => {
  let h: Harness;
  let releaseFirst!: () => void;

  beforeAll(async () => {
    const mock = new MockAdapter();
    let doTurns = 0;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const adapter: AgentAdapter = {
      provider: 'mock',
      async runTurn(input, ctx) {
        if (input.role === 'do' && doTurns++ === 0) await firstGate;
        return mock.runTurn(input, ctx);
      },
    };
    h = await bootHarness('mock', adapter);
  }, 60_000);

  afterAll(async () => {
    releaseFirst?.();
    await h?.stop();
  });

  it('uses the capacity label only after an acknowledged request is actually queued', async () => {
    (await h.store.setSettings('global', 'agent-queue', { capacity: 1 }));
    const repo = await h.makeRepo('agent-capacity');
    const start = async (title: string) => {
      const taskId = newId('task');
      const handle = await h.client.workflow.start('softwareDev@1.4.0', {
        taskQueue: TASK_QUEUE,
        workflowId: taskId,
        args: [{
          taskId,
          projectId: 'p1',
          title,
          prompt: '@review done',
          base: 'main',
          target: 'main',
          project: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false },
        }],
      });
      return { taskId, handle };
    };

    const first = await start('First');
    await expect.poll(async () => (await first.handle.query('view') as any).agentTurn?.state, { timeout: 20_000 })
      .toBe('running');

    const second = await start('Second');
    await expect.poll(async () => (await second.handle.query('view') as any).waitingFor?.detail, { timeout: 20_000 })
      .toBe('Waiting for host capacity to start agent');
    const queue = await h.client.workflow.getHandle(agentQueueId()).query('agentQueue') as any;
    expect(queue.current.map((x: any) => x.taskId)).toEqual([first.taskId]);
    expect(queue.queue.map((x: any) => x.taskId)).toEqual([second.taskId]);

    releaseFirst();
    await expect.poll(async () => (await second.handle.query('view') as any).stage, { timeout: 20_000 })
      .toBe('review');

    await first.handle.terminate('test done').catch(() => undefined);
    await second.handle.terminate('test done').catch(() => undefined);
  });
});
