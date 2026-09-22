import { it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker, bundleWorkflowCode } from '@temporalio/worker';
import { startDevServer } from '../src/temporal/dev-server.js';
import { makeClient } from '../src/temporal/client.js';

it('replays pre-patch publications and schedules separate compact maintenance in new histories', async () => {
  const server = await startDevServer({ headless: true, logLevel: 'never' });
  const conn = { address: server.address, namespace: server.namespace };
  const native = await NativeConnection.connect({ address: server.address });
  const { client, close } = await makeClient(conn);
  const currentPath = fileURLToPath(new URL('./fixtures/lifecycle-current.ts', import.meta.url));
  const legacyPath = fileURLToPath(new URL('./fixtures/lifecycle-legacy.ts', import.meta.url));
  const view = { taskId: 'fixture', title: 'Fixture', workflow: 'just-do', stage: 'do', status: 'waiting',
    world: { id: 'fixture', kind: 'memory', root: '/tmp', branch: 'task', base: 'main' }, state: {},
    waitingFor: { kind: 'human', audience: ['@creator'] }, updatedAt: 1, actions: [],
    messages: [{ role: 'user', content: 'A conversation that should not reach maintenance' }] };
  const publications: unknown[][] = [], maintenance: unknown[][] = [];
  try {
    const currentBundle = await bundleWorkflowCode({ workflowsPath: currentPath });
    for (const version of ['legacy', 'current']) {
      const taskQueue = `lifecycle-${version}`;
      const worker = await Worker.create({ connection: native, namespace: server.namespace, taskQueue,
        ...(version === 'legacy' ? { workflowsPath: legacyPath } : { workflowBundle: currentBundle }),
        maxCachedWorkflows: 2, maxConcurrentWorkflowTaskExecutions: 2, maxConcurrentActivityTaskExecutions: 2,
        reuseV8Context: true,
        activities: {
          publishView: async (...args: unknown[]) => { publications.push(args); return version === 'current' ? 'fence' : undefined; },
          parkWaitingWorld: async (...args: unknown[]) => { maintenance.push(args); },
          recordEvent: async () => {},
        },
      });
      const run = worker.run();
      try {
        for (const reference of [undefined, 'run:1']) {
          const handle = await client.workflow.start('lifecycleReplay', { workflowId: `${version}-${reference ?? 'full'}`,
            taskQueue, args: [view, reference] });
          await handle.result();
          const history = await handle.fetchHistory();
          await Worker.runReplayHistory({ workflowBundle: currentBundle }, history);
        }
      } finally { worker.shutdown(); await run; }
    }
    expect(publications.map(args => args.length)).toEqual([2, 3, 4, 4]);
    expect(maintenance).toHaveLength(2);
    for (const args of maintenance) {
      expect(args[0]).toBe('fixture');
      expect(args[2]).toBe('fence');
      expect(args[1]).toMatchObject({ status: 'waiting', world: view.world });
      expect(args[1]).not.toHaveProperty('messages');
      expect(args[1]).not.toHaveProperty('transcripts');
    }
  } finally { await close(); await native.close(); await server.stop(); }
}, 120_000);
