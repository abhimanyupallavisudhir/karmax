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

// pramana#137 failed because the snapshot before its sub-tasks (`commitWork`)
// outran a fixed 5-minute limit three times. That snapshot now heartbeats, and
// one that fails is the asking agent's to handle, like any sub-task that
// cannot be prepared: the run goes on.
it('tells the agent a sub-task\'s snapshot failed, and goes on', async () => {
  const turns: any[] = [];
  const views: any[] = [];
  let commits = 0;
  const env = await startStubTaskWorker({
    publishView: async (_taskId: string, view: any) => { views.push(view); return 'fence'; },
    recordEvent: async () => {}, parkWaitingWorld: async () => {},
    restoreChildTasks: async () => [], createWorld: async () => world,
    prepareAgentTurn: async () => ({ accountPool: 0 }), agentUsesHostCapacity: async () => false,
    releaseTaskRun: async () => 'unpinned', adoptTaskRun: async () => true,
    runAgentTurn: async (args: any) => {
      turns.push(args);
      return turns.length === 1
        ? { output: 'splitting', providerCompleted: true, subTasks: [{ title: 'Child', prompt: 'part' }, { title: 'Other', prompt: 'part' }] }
        : { output: 'noted', providerCompleted: true };
    },
    commitWork: async () => { commits++; throw ApplicationFailure.nonRetryable('git add -A: index.lock exists', 'Error'); },
    prepareChildTask: async () => { throw new Error('no sub-task may be prepared without its snapshot'); },
    pendingServiceConnections: async () => 0,
    buildReview: async () => ({ summary: 'fixture', changedFiles: [] }),
    suspendWorldForRecovery: async () => {}, closePrs: async () => [], destroyWorld: async () => {},
  });
  const workflowId = 'subtask-snapshot-fails';
  try {
    const handle = await env.client.workflow.start(`softwareDev@${version}`, { taskQueue: env.taskQueue, workflowId, args: [{
      taskId: workflowId, projectId: 'fixture', title: 'Splits', prompt: 'Do it.',
      project: { repos: ['/fixture'], remote: 'pr' },
    }] });
    await expect.poll(() => turns.length, { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
    const view: any = await handle.query('view');
    const told = view.messages.map((m: any) => m.text).join('\n');
    expect(told).toContain('create_sub_task "Child" failed: no sub-task was created. git add -A: index.lock exists.');
    expect(told).toContain('"Other" was not created either');
    expect(commits).toBe(1);
    expect((await handle.describe()).status.name).toBe('RUNNING');
    expect(views.some((view) => view.status === 'failed')).toBe(false);
    await handle.signal('cancel');
    await handle.result().catch(() => undefined);
    for (const run of await historyChain(env.client, workflowId))
      await Worker.runReplayHistory({ workflowBundle: env.workflowBundle }, run.history, run.runId);
  } finally {
    await env.stop();
  }
}, 120_000);

// pramana#137's pull request for "deploy-disk" failed its run when it could
// not move to the head its task's agent opened it at again. That agent is told
// instead, and the pull request waits at its last commit.
it('tells its task\'s agent when a pull request cannot move, and waits', async () => {
  const views: any[] = [];
  const called = new Set<string>();
  const stub = (name: string, value: unknown = undefined) => async () => { called.add(name); return value; };
  const env = await startStubTaskWorker({
    publishView: async (_taskId: string, view: any) => { views.push(view); return 'fence'; },
    recordEvent: stub('recordEvent'), parkWaitingWorld: stub('parkWaitingWorld'),
    restoreChildTasks: stub('restoreChildTasks', []), releaseTaskRun: stub('releaseTaskRun', 'unpinned'), adoptTaskRun: stub('adoptTaskRun', true),
    pendingServiceConnections: stub('pendingServiceConnections', 0),
    buildReview: stub('buildReview', { summary: 'fixture', changedFiles: [] }),
    movePullRequest: async () => { called.add('movePullRequest'); throw ApplicationFailure.nonRetryable("could not move the pull request to 77a46722: fatal: Could not parse object '77a46722'.\n", 'Error'); },
    suspendWorldForRecovery: stub('suspendWorldForRecovery'), closePrs: stub('closePrs', []), destroyWorld: stub('destroyWorld'),
    closePullRequest: stub('closePullRequest', { removed: true }), releasePullRequestData: stub('releasePullRequestData'),
    checkProposal: stub('checkProposal', { ready: true }), autoResolve: stub('autoResolve', { fixed: false }),
    openPr: stub('openPr', [{ slug: 'o/r', number: 1, url: 'https://github.com/o/r/pull/1', state: 'open', headSha: 'aaaa' }]),
    prepareProposal: stub('prepareProposal', {}), resourcesToReview: stub('resourcesToReview', false),
  });
  const workflowId = 'pull-request-cannot-move';
  const view = { ...world, meta: { pullRequest: workflowId } };
  try {
    const handle = await env.client.workflow.start(`softwareDev@${version}`, { taskQueue: env.taskQueue, workflowId, args: [{
      taskId: workflowId, projectId: 'fixture', title: 'deploy-disk', prompt: '', parentTaskId: 'parent-gone',
      project: { repos: ['/fixture'], remote: 'pr' }, shippedFrom: { taskId: 'parent-gone', checkout: 'deploy-disk', world: view },
    }] });
    await expect.poll(async () => ((await handle.query('view')) as any).stage, { timeout: 30_000 }).toBe('review');
    await handle.signal('pullRequestUpdated', { head: '77a46722' });
    await expect.poll(() => called.has('movePullRequest'), { timeout: 30_000 }).toBe(true);
    await expect.poll(async () => ((await handle.query('view')) as any).waitingFor?.kind, { timeout: 30_000 }).toBe('parent');
    expect((await handle.describe()).status.name).toBe('RUNNING');
    expect(views.some((v) => v.status === 'failed')).toBe(false);
    await handle.signal('cancel');
    await handle.result().catch(() => undefined);
    for (const run of await historyChain(env.client, workflowId))
      await Worker.runReplayHistory({ workflowBundle: env.workflowBundle }, run.history, run.runId);
  } finally {
    await env.stop();
  }
}, 120_000);
