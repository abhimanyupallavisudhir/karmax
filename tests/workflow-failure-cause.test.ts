import { it, expect } from 'vitest';
import { ApplicationFailure } from '@temporalio/activity';
import { WorkflowFailedError } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import { startStubTaskWorker, historyChain } from './helpers/stub-task-worker.js';
import { MANIFESTS } from '../src/contrib/manifests.js';

const world = { id: 'failure-fixture', kind: 'memory', root: '/fixture', branch: 'task', base: 'main' };
const version = MANIFESTS.find((m) => m.name === 'software-dev')!.version;

// A run that failed was settled a minute later by the reconciler as only
// "workflow failed", and Retry told the agent the same; the cause stayed in
// Temporal's history (pramana#13, #137). The run now says why, and where Retry
// resumes, before it closes.
it('publishes why a run failed, and the stage it failed in, before it closes', async () => {
  const views: any[] = [];
  const env = await startStubTaskWorker({
    publishView: async (_taskId: string, view: any) => { views.push(view); return 'fence'; },
    recordEvent: async () => {}, parkWaitingWorld: async () => {},
    restoreChildTasks: async () => [], createWorld: async () => world,
    prepareAgentTurn: async () => ({ accountPool: 0 }), agentUsesHostCapacity: async () => false,
    releaseTaskRun: async () => 'unpinned', adoptTaskRun: async () => true,
    runAgentTurn: async () => ({ output: 'done', providerCompleted: true }),
    pendingServiceConnections: async () => { throw ApplicationFailure.nonRetryable('the connections table is unreadable', 'Unreadable'); },
    buildReview: async () => ({ summary: 'fixture', changedFiles: [] }),
    suspendWorldForRecovery: async () => {}, closePrs: async () => [], destroyWorld: async () => {},
  });
  const workflowId = 'failure-names-cause';
  try {
    const handle = await env.client.workflow.start(`softwareDev@${version}`, { taskQueue: env.taskQueue, workflowId, args: [{
      taskId: workflowId, projectId: 'fixture', title: 'Fails', prompt: 'Do it.',
      project: { repos: ['/fixture'], remote: 'pr' },
    }] });
    const failure = await handle.result().then(() => undefined, (error) => error);
    expect(failure).toBeInstanceOf(WorkflowFailedError);
    const last = views.at(-1);
    expect(last).toMatchObject({
      stage: 'failed', status: 'failed',
      error: 'workflow failed in pendingServiceConnections: the connections table is unreadable',
      state: { failedFrom: expect.any(String), recoveryWorld: world },
    });
    expect(['do', 'review', 'pr']).toContain(last.state.failedFrom);
    // The publication is part of the run's history, and replays.
    for (const run of await historyChain(env.client, workflowId))
      await Worker.runReplayHistory({ workflowBundle: env.workflowBundle }, run.history, run.runId);
  } finally {
    await env.stop();
  }
}, 120_000);
