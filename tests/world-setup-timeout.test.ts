import { expect, it } from 'vitest';
import { Context } from '@temporalio/activity';
import { startStubTaskWorker } from './helpers/stub-task-worker.js';

// pramana #191 (2026-11-09): `createWorld` had a 30-minute start-to-close for
// everything world setup does, restoring the project's data included, and a
// 31 GB restore needed about that long on its own. Temporal's limit is now a
// backstop for a worker that hangs; the activity enforces setup's own budget
// (src/world/setup-clock.ts) and its heartbeat still finds a dead worker.
it('schedules world setup with a backstop start-to-close and a one-minute heartbeat', async () => {
  let seen: { startToCloseTimeoutMs?: number; heartbeatTimeoutMs?: number } | undefined;
  const env = await startStubTaskWorker({
    publishView: async () => 'fence', recordEvent: async () => {}, restoreChildTasks: async () => [],
    createWorld: async () => {
      const info = Context.current().info;
      seen = { startToCloseTimeoutMs: info.startToCloseTimeoutMs, heartbeatTimeoutMs: info.heartbeatTimeoutMs };
      throw new Error('enough');
    },
    parkWaitingWorld: async () => {}, prepareAgentTurn: async () => ({ accountPool: 0 }), agentUsesHostCapacity: async () => false,
    pendingServiceConnections: async () => 0, suspendWorldForRecovery: async () => {}, closePrs: async () => [], destroyWorld: async () => {},
  });
  const workflowId = 'world-setup-timeout';
  try {
    await env.client.workflow.start('softwareDev@1.30.0', { taskQueue: env.taskQueue, workflowId, args: [{
      taskId: workflowId, projectId: 'fixture', title: 'Setup', prompt: 'Start.', project: { repos: ['/fixture'], remote: 'pr' },
    }] });
    await expect.poll(() => seen, { timeout: 30_000, interval: 50 }).toBeDefined();
    expect(seen!.startToCloseTimeoutMs).toBe(12 * 60 * 60_000);
    expect(seen!.heartbeatTimeoutMs).toBe(60_000);
  } finally {
    await env.client.workflow.getHandle(workflowId).signal('cancel').catch(() => undefined);
    await env.client.workflow.getHandle(workflowId).terminate('test over').catch(() => undefined);
    await env.stop();
  }
}, 120_000);
