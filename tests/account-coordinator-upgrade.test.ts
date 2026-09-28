import { it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker, bundleWorkflowCode } from '@temporalio/worker';
import { startDevServer } from '../src/temporal/dev-server.js';
import { makeClient } from '../src/temporal/client.js';
import { accountCoordinatorId, SIG_ACCOUNT_GRANTED } from '../src/coordinators/names.js';

/**
 * The account coordinator is a long-lived singleton with no version pin, so a
 * deploy replays its history against new code. Task 385 was parked on an
 * exhausted login when a second login was added; its allow-list predated that
 * login, so it waited out the quota window. After the deploy that teaches the
 * coordinator to re-list parked requests, the next credential sync must reach a
 * request parked under the old code at once — not after the wait it was stuck in.
 */
it('re-lists a request parked under the pre-relist coordinator on the next credential sync', async () => {
  const server = await startDevServer({ headless: true, logLevel: 'never' });
  const native = await NativeConnection.connect({ address: server.address });
  const { client, close } = await makeClient({ address: server.address, namespace: server.namespace });
  const taskQueue = 'account-upgrade';
  const worker = async (version: 'legacy' | 'current') => {
    const workflowBundle = await bundleWorkflowCode({
      workflowsPath: fileURLToPath(new URL(`./fixtures/account-upgrade-${version}.ts`, import.meta.url)),
    });
    const w = await Worker.create({
      connection: native, namespace: server.namespace, taskQueue, workflowBundle,
      maxCachedWorkflows: 2, maxConcurrentWorkflowTaskExecutions: 2, maxConcurrentActivityTaskExecutions: 2,
      activities: { isTaskAlive: async () => true },
    });
    const run = w.run();
    let stopped = false;
    return { bundle: workflowBundle, stop: async () => { if (!stopped) { stopped = true; w.shutdown(); await run; } } };
  };
  let running: Awaited<ReturnType<typeof worker>> | undefined;
  const grants = async (taskId: string) => {
    const history = await client.workflow.getHandle(taskId).fetchHistory();
    return (history.events ?? []).flatMap((event: any) => {
      const signal = event.workflowExecutionSignaledEventAttributes;
      if (signal?.signalName !== SIG_ACCOUNT_GRANTED) return [];
      return [JSON.parse(Buffer.from(signal.input.payloads[0].data).toString('utf8')).accountId];
    });
  };
  const mats = { id: 'login:claude:mats', configHome: '/tmp/mats', provider: 'claude', kind: 'login' };
  const fresh = { id: 'login:claude:fresh', configHome: '/tmp/fresh', provider: 'claude', kind: 'login' };
  try {
    running = await worker('legacy');
    const coordinator = await client.workflow.start('accountCoordinator', {
      taskQueue, workflowId: accountCoordinatorId(),
      args: [{ state: { processed: 0, queue: [], accounts: [{
        ...mats, maxConcurrent: 10, inUse: 0, status: 'exhausted', window: '5h', resetAt: Date.now() + 3_600_000,
      }] } }],
    });
    await client.workflow.start('accountGrantee', { taskQueue, workflowId: 'task-385' });
    await coordinator.signal('leaseAccount', { taskId: 'task-385', turnId: 't', provider: 'claude', allowed: [mats.id] });
    await expect.poll(async () => coordinator.query('accountLease', { taskId: 'task-385' }), { timeout: 20_000 })
      .toMatchObject({ waiting: true, earliestResetAt: expect.any(Number) });
    // A second login is added while it waits; the old code cannot offer it.
    await coordinator.signal('registerAccounts', { accounts: [mats, fresh] });
    await expect.poll(async () => ((await coordinator.query('accounts')) as any).accounts.length, { timeout: 20_000 }).toBe(2);
    expect(await coordinator.query('accountLease', { taskId: 'task-385' })).toMatchObject({ waiting: true });
    // Parked in the quota wait, with no pending work, exactly as in production.
    await expect.poll(async () => (await coordinator.describe()).raw.pendingWorkflowTask, { timeout: 20_000 }).toBeFalsy();
    await running.stop();
    expect(await grants('task-385')).toEqual([]);

    running = await worker('current');
    // The deploy's boot sync: the same two credentials the pool already knows.
    await coordinator.signal('registerAccounts', { accounts: [mats, fresh] });
    await expect.poll(() => grants('task-385'), { timeout: 20_000 }).toEqual(['(relist)']);
    expect(await coordinator.query('accountLease', { taskId: 'task-385' })).toEqual({ waiting: false });
    // The request re-resolved against today's credentials and got the new login.
    await coordinator.signal('leaseAccount', { taskId: 'task-385', turnId: 't', provider: 'claude', allowed: [fresh.id, mats.id] });
    await expect.poll(() => grants('task-385'), { timeout: 20_000 }).toEqual(['(relist)', fresh.id]);

    // The recorded upgrade replays deterministically on the current code.
    await Worker.runReplayHistory({ workflowBundle: running.bundle }, await coordinator.fetchHistory());
    await running.stop();
  } finally {
    await running?.stop();
    await close();
    await native.close();
    await server.stop();
  }
}, 180_000);
