import { it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker, bundleWorkflowCode } from '@temporalio/worker';
import { startDevServer } from '../src/temporal/dev-server.js';
import { makeClient } from '../src/temporal/client.js';
import { AGENT_QUEUE_DRAIN_PATCH } from '../src/coordinators/agent-queue.js';
import { agentQueueId } from '../src/coordinators/names.js';

/**
 * The agent queue has no version pin: a deploy replays its running history
 * against new code. The drain (answer parked waiters, then continue as new) is
 * gated on a patch marker, so a run recorded before it keeps the old rule —
 * never rotating over a parked Update — until it rotates on its own, and the
 * run after that drains.
 */
it('a queue run recorded before the drain keeps its rule, then rotates into one that drains', async () => {
  const server = await startDevServer({ headless: true, logLevel: 'never' });
  const native = await NativeConnection.connect({ address: server.address });
  const { client, close } = await makeClient({ address: server.address, namespace: server.namespace });
  const taskQueue = 'agent-queue-upgrade';
  const worker = async (version: 'legacy' | 'current') => {
    const workflowBundle = await bundleWorkflowCode({
      workflowsPath: fileURLToPath(new URL(version === 'legacy'
        ? './fixtures/agent-queue-legacy.ts' : '../src/coordinators/agent-queue.ts', import.meta.url)),
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
  const queue = client.workflow.getHandle(agentQueueId());
  const wait = (turnId: string) => queue.executeUpdate('waitAgentSlot', { args: [{ taskId: turnId, turnId, role: 'do' }] });
  const view = async () => (await queue.query('agentQueue')) as { queue: { turnId: string }[]; current: { turnId: string }[] };
  const markers = async (runId: string) => ((await client.workflow.getHandle(agentQueueId(), runId).fetchHistory()).events ?? [])
    .filter((event: any) => event.markerRecordedEventAttributes).length;
  let running: Awaited<ReturnType<typeof worker>> | undefined;
  try {
    running = await worker('legacy');
    const first = await client.workflow.start('agentQueue', {
      taskQueue, workflowId: agentQueueId(),
      args: [{ state: { capacity: 1, queue: [], current: [{ taskId: 'holder', turnId: 'holder' }], processed: 49, modern: true } }],
    });
    const waiting = [wait('a'), wait('b')];
    await expect.poll(async () => (await view()).queue.map((x) => x.turnId), { timeout: 20_000 }).toEqual(['a', 'b']);
    await expect.poll(async () => (await queue.describe()).raw.pendingWorkflowTask, { timeout: 20_000 }).toBeFalsy();
    await running.stop();

    running = await worker('current');
    // 50 grants are due, but `b` is parked: the pre-drain run must not rotate.
    await queue.signal('releaseAgentSlot', { taskId: 'holder', turnId: 'holder' });
    await expect(waiting[0]).resolves.toBe(true);
    expect((await queue.describe()).runId).toBe(first.firstExecutionRunId);
    expect(await view()).toMatchObject({ current: [{ turnId: 'a' }], queue: [{ turnId: 'b' }] });
    // With nobody parked it rotates under its own rule; the next run drains.
    await queue.signal('releaseAgentSlot', { taskId: 'a', turnId: 'a' });
    await expect(waiting[1]).resolves.toBe(true);
    await expect.poll(async () => (await queue.describe()).runId, { timeout: 20_000 }).not.toBe(first.firstExecutionRunId);
    expect(await view()).toMatchObject({ current: [{ turnId: 'b' }], queue: [] });
    expect(await markers(first.firstExecutionRunId)).toBe(0);
    const next = (await queue.describe()).runId;
    await expect.poll(() => markers(next), { timeout: 20_000 }).toBe(1);
    const marker = ((await client.workflow.getHandle(agentQueueId(), next).fetchHistory()).events ?? [])
      .find((event: any) => event.markerRecordedEventAttributes) as any;
    const details = Object.values(marker.markerRecordedEventAttributes.details as Record<string, { payloads: { data: Uint8Array }[] }>)
      .flatMap((detail) => detail.payloads.map((payload) => Buffer.from(payload.data).toString()));
    expect(details.join()).toContain(AGENT_QUEUE_DRAIN_PATCH);

    // The upgraded run replays deterministically on the current code.
    await Worker.runReplayHistory({ workflowBundle: running.bundle },
      await client.workflow.getHandle(agentQueueId(), first.firstExecutionRunId).fetchHistory());
  } finally {
    await running?.stop();
    await close();
    await native.close();
    await server.stop();
  }
}, 180_000);
