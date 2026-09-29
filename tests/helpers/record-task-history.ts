/**
 * Records a task workflow history for replay fixtures (tests/history-replay.test.ts):
 * a real Temporal server and worker over stub activities drive one scenario,
 * and the still-running execution's history is written as JSON.
 *
 *   npx tsx tests/helpers/record-task-history.ts <scenario> <workflowType> <out.json>
 *
 * To record what a change must keep replaying, run it from a checkout of the
 * commit before the change (copy this file and stub-task-worker.ts there if
 * they are newer). Scenarios: landing-duplicate, merge-queue-wait, long,
 * subtask-barrier, merge-failed (mergeOnly), turn-failed (justDo); the last two
 * record the whole closed execution.
 */
import fs from 'node:fs';
import { ApplicationFailure } from '@temporalio/common';
import { startStubTaskWorker, historyChain, type StubActivities } from './stub-task-worker.js';

const [scenario, workflowType, out] = process.argv.slice(2);
if (!scenario || !workflowType || !out) throw new Error('usage: record-task-history <scenario> <workflowType> <out.json>');

// just-do releases only remote worlds, so its failure runs in a (stub) sandbox.
const world = { id: `${scenario}-fixture`, kind: scenario === 'turn-failed' ? 'e2b' : 'memory', root: '/fixture', branch: 'task', base: 'main' };
const prs = [{ slug: 'test/repo', number: 1, headSha: 'abc', url: 'https://github.com/test/repo/pull/1' }];
const calls = new Map<string, number>();
const count = (name: string) => calls.get(name) ?? 0;
const common: StubActivities = {
  // A replacement parent restores a child it holds no handle for.
  restoreChildTasks: async () => scenario === 'subtask-barrier' ? [{ taskId: 'child-1', title: 'Child', waiting: false }] : [],
  publishView: async () => 'fence', parkWaitingWorld: async () => {},
  recordEvent: async () => {}, createWorld: async () => world, prepareAgentTurn: async () => ({ accountPool: 0 }),
  accountPoolSize: async () => 0,
  agentUsesHostCapacity: async () => false, pendingServiceConnections: async () => 0,
  buildReview: async () => ({ summary: 'fixture', changedFiles: [] }), checkProposal: async () => ({ ready: true }),
  suspendWorldForRecovery: async () => {}, closePrs: async () => prs, destroyWorld: async () => {},
  settleResourceReview: async () => ({ settled: true }), openPr: async () => prs,
  withdrawGithubPrs: async () => ({ withdrawn: [], reconciled: prs }),
  // Landing takes the Karmax slot at once; the merge-queue wait never gets it.
  enqueueMerge: async (_domain: string, taskId: string) => {
    if (scenario !== 'merge-queue-wait') await env.client.workflow.getHandle(taskId).signal('mergeGranted');
  }, releaseMerge: async () => {}, cancelMerge: async () => {},
  mergeQueuePosition: async () => ({ position: 2, total: 3 }),
  finalizeMergeActivity: async () => ({ merged: false, conflict: 'CONFLICT (content): Merge conflict in index.js' }),
  mergeGithubPrs: async () => ({ status: 'needs-revision', prs, detail: 'CI failed on the same head.',
    repair: { kind: 'ci', preserveAuthorization: true, fingerprint: 'test/repo#1:abc:ci' } }),
};
let turns = 0;
const replies = (i: number) => `Reply ${i}. ${'r'.repeat(200)}`;
const counted = Object.fromEntries(Object.entries({
  ...common,
  runAgentTurn: async () => {
    if (scenario === 'turn-failed') throw ApplicationFailure.nonRetryable('agent refused the task', 'agent-error');
    return { output: replies(turns++), providerCompleted: true,
      ...(scenario === 'subtask-barrier' ? { waitForSubtasks: true } : {}) };
  },
}).map(([name, fn]) => [name, async (...args: unknown[]) => {
  calls.set(name, count(name) + 1);
  return (fn as (...values: unknown[]) => unknown)(...args);
}]));

const workflowId = `${scenario}-fixture`;
const inputs: Record<string, unknown> = {
  'landing-duplicate': { taskId: workflowId, projectId: 'fixture', title: 'Landing fixture', prompt: '',
    project: { repos: ['/fixture'], remote: 'pr' }, githubPollMs: 5000, recovery: { resumeStage: 'merge', messages: [], prs, world,
      landing: { authorization: 'authorized', validation: 'pending', provider: 'admitting', authorizedHeads: { 'test/repo#1': 'abc' },
        lastRepairFingerprint: 'test/repo#1:abc:ci', repairAttempts: 1 } } },
  'merge-queue-wait': { taskId: workflowId, projectId: 'fixture', title: 'Merge queue fixture', prompt: '',
    project: { repos: ['/fixture'] }, recovery: { resumeStage: 'merge', messages: [], world } },
  'subtask-barrier': { taskId: workflowId, projectId: 'fixture', title: 'Barrier fixture', prompt: '',
    project: { repos: ['/fixture'] }, recovery: { resumeStage: 'do', messages: [{ id: 'm0', role: 'user', text: 'Delegate', ts: 0 }], world } },
  'merge-failed': { taskId: workflowId, projectId: 'fixture', title: 'Failed merge fixture', prompt: '',
    branch: 'task', project: { repos: ['/fixture'] }, confirm: { layers: [] } },
  'turn-failed': { taskId: workflowId, projectId: 'fixture', title: 'Failed turn fixture', prompt: 'Work',
    project: { repos: ['/fixture'], worldProvider: 'e2b' } },
  long: { taskId: workflowId, projectId: 'fixture', title: 'Long task', prompt: `Start. ${'p'.repeat(500)}`,
    project: { repos: ['/fixture'], remote: 'pr' } },
};
const until: Record<string, () => boolean> = {
  'landing-duplicate': () => count('mergeGithubPrs') >= 5,
  'merge-queue-wait': () => count('mergeQueuePosition') >= 2,
  'subtask-barrier': () => count('runAgentTurn') >= 1,
};

const env = await startStubTaskWorker(counted);
try {
  const handle = await env.client.workflow.start(workflowType, { taskQueue: env.taskQueue, workflowId, args: [inputs[scenario]] });
  const wait = async (done: () => Promise<boolean> | boolean) => {
    for (const started = Date.now(); !(await done());) {
      if (Date.now() - started > 300_000) throw new Error(`${scenario}: timed out`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  if (scenario === 'long') {
    // Until the run passes the 4,000-event continue-as-new threshold at a Do turn.
    const target = Number(process.env.KARMAX_RECORD_EVENTS ?? 4_200);
    for (let i = 1; ; i++) {
      await wait(async () => {
        const view: any = await handle.query('view');
        return turns >= i && view.status === 'waiting' && view.waitingFor?.kind === 'human';
      });
      if ((await handle.describe()).historyLength >= target) break;
      await handle.signal('followUp', { id: `u${i}`, role: 'user', text: `Follow-up ${i}. ${'u'.repeat(100)}`, ts: i });
    }
  } else if (scenario === 'merge-failed' || scenario === 'turn-failed') {
    await handle.result().catch(() => undefined);
  } else await wait(until[scenario]!);
  if (scenario === 'subtask-barrier') {
    // A follow-up wakes the barrier, so the parked wait is followed by events
    // a changed wait would contradict on replay.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await handle.signal('followUp', { id: 'u1', role: 'user', text: 'Carry on', ts: 1 });
    await wait(() => count('runAgentTurn') >= 2);
  }
  // Let the workflow task that reacts to the last activity complete.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const [run] = await historyChain(env.client, workflowId);
  fs.writeFileSync(out, JSON.stringify(run!.history.toJSON()));
  process.stderr.write(`${scenario} ${workflowType}: ${run!.events} events, ${run!.bytes} bytes\n`);
  await handle.terminate('recorded').catch(() => undefined);
} finally { await env.stop(); }
