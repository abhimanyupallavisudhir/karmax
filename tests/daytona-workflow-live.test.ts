import { describe, expect, it } from 'vitest';
import { bootHarness } from './helpers/harness.js';
import { MockAdapter } from '../src/agent/mock.js';
import { DaytonaWorldProvider } from '../src/world/daytona.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import type { WorldHandle } from '../src/world/types.js';

// Explicit opt-in: real Temporal, real cloud credit, deterministic model.
describe.skipIf(process.env.KARMAX_DAYTONA_LIVE_WORKFLOW !== '1')('Daytona task end to end', () => {
  it('runs task setup, agent commands, output checkpointing and teardown with only an API key', async () => {
    if (!process.env.DAYTONA_API_KEY) throw new Error('DAYTONA_API_KEY is required');
    const provider = new DaytonaWorldProvider();
    const mock = new MockAdapter();
    let observed: WorldHandle | undefined;
    const h = await bootHarness('mock', { provider: 'mock', async runTurn(input, ctx) {
      observed = input.world.handle;
      expect(observed.kind).toBe('daytona');
      const result = await mock.runTurn(input, ctx);
      expect(await input.world.readFile('result.txt')).toBe('Daytona task complete');
      return result;
    } }, { checkpoints: true });
    h.worlds.register(provider);
    const project = (await h.store.createProject('Daytona live workflow', { worldProvider: 'daytona', repos: [] }));
    const taskId = `live-daytona-workflow-${Date.now()}`;
    let task: Awaited<ReturnType<typeof h.client.workflow.start>> | undefined;
    try {
      task = await h.client.workflow.start('justDo@1.7.0', { taskQueue: TASK_QUEUE, workflowId: taskId, args: [{
        taskId, projectId: project.id, title: 'Daytona live workflow',
        prompt: '@write result.txt ::Daytona task complete\n@run test -f result.txt',
        base: 'main', target: 'main', project: { worldProvider: 'daytona', repos: [] },
        agents: { do: { provider: 'mock' } },
      }] });
      const completion = task.result();
      await Promise.race([
        expect.poll(async () => (await task!.query<any>('view')).stage, { timeout: 240_000, interval: 1000 }).toBe('review'),
        completion.then(() => { throw new Error('Task ended before review'); }),
      ]);
      await task.signal('confirm');
      expect((await completion as any).stage).toBe('done');
      expect(observed).toBeDefined();
      expect((await h.store.latestWorldCheckpoint(observed!.id))?.filesystemDelta?.bytes).toBeGreaterThan(0);
      expect(await provider.probe(observed!)).toBe('missing');
      expect(JSON.stringify(await task.fetchHistory())).not.toContain(process.env.DAYTONA_API_KEY);
    } finally {
      await task?.signal('cancel').catch(() => undefined);
      try { await h.stop(); }
      finally {
        // Teardown failures must not leave a billable live-test sandbox behind.
        for (const entry of await provider.listSandboxes()) if (entry.taskId === taskId) await entry.destroy();
      }
    }
  }, 360_000);
});
