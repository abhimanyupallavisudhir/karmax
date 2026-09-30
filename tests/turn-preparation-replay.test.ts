import { it, expect } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { makeTurnPreparationActivities } from '../src/activities/turn-preparation.js';
import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker, bundleWorkflowCode } from '@temporalio/worker';
import { startDevServer } from '../src/temporal/dev-server.js';
import { makeClient } from '../src/temporal/client.js';

// A leased turn's first `agent-turn-run-identity-v1` marker is a command, so its
// position relative to resolveCredentialOrder is part of the history. Before
// credential re-listing (334680f3) the allow-list was resolved first; since then
// the marker comes first. All three orders recorded in the wild must replay:
// this branch's pre-change code, the revision production ran until 2026-09-28
// (recorded at 334680f3^ by master's hotfix #417), and master's re-listing (3ac2913b).
const replayBundle = bundleWorkflowCode({ workflowsPath: fileURLToPath(new URL('../src/workflows/index.ts', import.meta.url)) });
it.each([
  ['resolved before the turn id, by this branch before re-listing', 'turn-preparation-prechange-history.json'],
  ['resolved before the turn id, by production until 2026-09-28', 'turn-preparation-production-history.json'],
  ['resolved after the turn id', 'turn-preparation-relist-history.json'],
])('replays a leased turn whose allow-list was %s', async (_order, fixture) => {
  const { temporal } = createRequire(import.meta.url)('@temporalio/proto');
  await Worker.runReplayHistory({ workflowBundle: await replayBundle }, temporal.api.history.v1.History.fromObject(
    JSON.parse(fs.readFileSync(new URL(`./fixtures/${fixture}`, import.meta.url), 'utf8'))));
}, 60_000);

it('prepares one leased turn with one Starting agent publication', async () => {
  const server = await startDevServer({ headless: true, logLevel: 'never' });
  const native = await NativeConnection.connect({ address: server.address });
  const { client, close } = await makeClient({ address: server.address, namespace: server.namespace });
  const taskQueue = 'turn-preparation-test', taskId = 'turn-preparation-fixture';
  const views: any[] = [];
  let running = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const bundle = await replayBundle;
  const preparation = makeTurnPreparationActivities({ resolveProvider: async () => 'claude', resolveCredentialOrder: async () => ['fixture'] },
    { accountPoolSize: async () => 1 });
  const worker = await Worker.create({ connection: native, namespace: server.namespace, taskQueue, workflowBundle: bundle,
    maxCachedWorkflows: 2, maxConcurrentWorkflowTaskExecutions: 2, maxConcurrentActivityTaskExecutions: 2, reuseV8Context: true,
    activities: {
      ...preparation,
      publishView: async (_id: string, view: any) => { views.push(view); return 'fence'; }, parkWaitingWorld: async () => {},
      recordEvent: async () => {}, pendingServiceConnections: async () => [], restoreChildTasks: async () => [], accountPoolSize: async () => 1,
      resolveProvider: async () => 'claude', resolveCredentialOrder: async () => ['fixture'],
      leaseAccount: async (_id: string, turnId: string) => {
        await client.workflow.getHandle(taskId).signal('accountGranted', { turnId, accountId: 'fixture', configHome: '/fixture', credentialKind: 'login' });
        return { waiting: false };
      },
      agentUsesHostCapacity: async () => true, requestAgentSlot: async () => ({ granted: true, queueId: 'fixture' }),
      releaseAgentSlot: async () => {}, returnAccount: async () => {},
      runAgentTurn: async () => { running = true; await gate; return { completed: false, output: '' }; },
      suspendWorldForRecovery: async () => {}, closePrs: async () => {}, withdrawGithubPrs: async () => ({ withdrawn: [], reconciled: [] }),
    },
  });
  const run = worker.run();
  const handle = await client.workflow.start('softwareDev@1.26.0', { taskQueue, workflowId: taskId, args: [{
    taskId, projectId: 'fixture', title: 'Turn fixture', prompt: '', project: { repos: ['/fixture'], remote: 'pr' },
    recovery: { resumeStage: 'do', messages: [], world: { id: taskId, kind: 'memory', root: '/fixture', branch: 'task', base: 'main' } },
  }] });
  try {
    await expect.poll(() => running, { timeout: 20_000 }).toBe(true);
    const history = await handle.fetchHistory();
    const activities = history.events!.flatMap(event => event.activityTaskScheduledEventAttributes?.activityType?.name ?? []);
    process.stderr.write(JSON.stringify({ activities, starting: views.filter(view => view.waitingFor?.detail === 'Starting agent').length }) + '\n');
    expect(activities.slice(activities.indexOf('prepareAgentTurn'))).toEqual([
      'prepareAgentTurn', 'leaseAccount', 'agentUsesHostCapacity', 'requestAgentSlot', 'publishView', 'runAgentTurn',
    ]);
    expect(views.filter(view => view.waitingFor?.detail === 'Starting agent')).toHaveLength(1);
  } finally {
    try { await handle.signal('cancel'); release(); await handle.result(); }
    finally { release(); worker.shutdown(); await run; await close(); await native.close(); await server.stop(); }
  }
}, 60_000);
