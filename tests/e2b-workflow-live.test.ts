import { describe, expect, it } from 'vitest';
import { bootHarness } from './helpers/harness.js';
import { liveEnabled } from './helpers/live-gate.js';
import { MockAdapter } from '../src/agent/mock.js';
import { E2BWorldProvider } from '../src/world/e2b.js';
import type { WorldHandle } from '../src/world/types.js';

// tavya.io runs every task in an E2B sandbox. The E2B smoke suite (cloud-live)
// only creates, uses and destroys one; this drives a real task through the
// hosted lifecycle, created and steered through the platform API as the console
// does: setup, agent commands, a checkpoint and pause at Review, a resume on a
// follow-up with the files intact, and teardown. Real Temporal, real E2B credit
// (one small sandbox for a few minutes), deterministic model.
describe.skipIf(!liveEnabled() || !process.env.E2B_API_KEY)('E2B task end to end', () => {
  it('parks at Review, resumes on a follow-up with its files, and tears the sandbox down', async () => {
    const provider = new E2BWorldProvider();
    const mock = new MockAdapter();
    const worldsSeen: WorldHandle[] = [];
    const h = await bootHarness('mock', { provider: 'mock', async runTurn(input, ctx) {
      worldsSeen.push(input.world.handle);
      expect(input.world.handle.kind).toBe('e2b');
      // The second turn runs after the pause: the first turn's output must survive it.
      if (worldsSeen.length > 1) expect(await input.world.readFile('result.txt')).toBe('E2B task complete');
      return mock.runTurn(input, ctx);
    } }, { checkpoints: true });
    h.worlds.register(provider);
    let taskId: string | undefined;
    let token: string | undefined;
    try {
      const project = (await h.store.createProject('E2B live workflow', { worldProvider: 'e2b', repos: [] }));
      token = (await h.tokens.mintPrincipal('user:live', ['*'], project.id)).token;
      const task = await h.api.createTask(token, { projectId: project.id, title: 'E2B live workflow', workflow: 'just-do',
        prompt: '@write result.txt ::E2B task complete\n@run test -f result.txt',
        params: { 'agent:do': { provider: 'mock' } } });
      taskId = task.id;
      const handle = h.client.workflow.getHandle(task.id);
      const view = async () => (await handle.query<any>('view'));
      const ended = handle.result().then(() => { throw new Error('Task ended early'); });
      // On a timeout, name what the task did instead.
      const trail = async () => (await h.store.eventsSince(task.id, 0)).map((event) => event.type)
        .filter((type) => !type.startsWith('agent.output')).slice(-40).join(', ');
      const until = (what: string, check: () => Promise<boolean>) => Promise.race([ended,
        expect.poll(check, { timeout: 240_000, interval: 2000, message: what }).toBe(true)
          .catch(async (error) => { throw new Error(`${error.message}; events: ${await trail()}`); })]);

      await until('first Review', async () => (await view()).stage === 'review');
      // Waiting for a human pauses the sandbox after a short grace, checkpointing it first.
      await until('world parked', async () => (await h.store.eventsOfType(task.id, 'world.parked')).length > 0);
      expect(await h.store.eventsOfType(task.id, 'checkpoint.warning')).toEqual([]);
      expect((await h.store.latestWorldCheckpoint(worldsSeen[0]!.id))?.filesystemDelta?.bytes).toBeGreaterThan(0);

      await h.api.signalTask(token, task.id, 'followUp', '@write second.txt ::resumed\n@run test -f second.txt');
      await until('resumed turn', async () => worldsSeen.length === 2);
      await until('second Review', async () => (await view()).stage === 'review' && (await view()).status === 'waiting');

      // Review gates need a verified human reviewer, which this test principal is not.
      await handle.signal('confirm');
      expect((await handle.result() as any).stage).toBe('done');
      expect(await provider.probe(worldsSeen[0]!)).toBe('missing');
      expect(JSON.stringify(await handle.fetchHistory())).not.toContain(process.env.E2B_API_KEY);
    } finally {
      if (taskId && token) await h.api.signalTask(token, taskId, 'cancel').catch(() => undefined);
      try { await h.stop(); }
      finally {
        // Teardown failures must not leave a billable live-test sandbox behind.
        for (const entry of await provider.listSandboxes()) if (entry.taskId === taskId) await entry.destroy();
      }
    }
  }, 900_000);
});
