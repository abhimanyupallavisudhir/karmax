import { it, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker, bundleWorkflowCode } from '@temporalio/worker';
import { temporal } from '@temporalio/proto';
import { startDevServer } from '../src/temporal/dev-server.js';
import { makeClient } from '../src/temporal/client.js';

// A leased turn's first `agent-turn-run-identity-v1` marker is a command, so its
// position relative to resolveCredentialOrder is part of the history. Before
// credential re-listing (334680f3) the allow-list was resolved first; since then
// the marker comes first. Both fixtures come from the live run below: the first
// recorded at 334680f3^, the second at 3ac2913b. Both orders must replay.
const bundle = bundleWorkflowCode({ workflowsPath: fileURLToPath(new URL('../src/workflows/index.ts', import.meta.url)) });
const history = (fixture: string) => temporal.api.history.v1.History.fromObject(
  JSON.parse(fs.readFileSync(new URL(`./fixtures/${fixture}`, import.meta.url), 'utf8')));

it.each([
  ['resolved before the turn id', 'turn-preparation-prechange-history.json'],
  ['resolved after the turn id', 'turn-preparation-relist-history.json'],
])('replays a leased turn whose allow-list was %s', async (_order, fixture) => {
  await Worker.runReplayHistory({ workflowBundle: await bundle }, history(fixture));
}, 60_000);

// Set KARMAX_RECORD_TURN_FIXTURE=<path> to write this run's history as a fixture.
it('records the turn id before resolving a live leased turn', async () => {
  const server = await startDevServer({ headless: true, logLevel: 'never' });
  const native = await NativeConnection.connect({ address: server.address });
  const { client, close } = await makeClient({ address: server.address, namespace: server.namespace });
  const taskQueue = 'turn-preparation-test', taskId = 'turn-preparation-fixture';
  let running = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const worker = await Worker.create({ connection: native, namespace: server.namespace, taskQueue, workflowBundle: await bundle,
    maxCachedWorkflows: 2, maxConcurrentWorkflowTaskExecutions: 2, maxConcurrentActivityTaskExecutions: 2, reuseV8Context: true,
    activities: {
      publishView: async () => 'fence', parkWaitingWorld: async () => {},
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
    const recorded = await handle.fetchHistory();
    if (process.env.KARMAX_RECORD_TURN_FIXTURE) {
      fs.writeFileSync(process.env.KARMAX_RECORD_TURN_FIXTURE,
        JSON.stringify(temporal.api.history.v1.History.fromObject(recorded).toJSON()));
    }
    const commands = recorded.events!.flatMap(event => {
      const activity = event.activityTaskScheduledEventAttributes?.activityType?.name;
      const patch = event.markerRecordedEventAttributes?.details?.['patch-data']?.payloads?.[0]?.data;
      return activity ? [activity] : patch ? [`patch:${JSON.parse(Buffer.from(patch).toString()).id}`] : [];
    });
    expect(commands.slice(commands.indexOf('resolveProvider'))).toEqual([
      'resolveProvider', 'patch:agent-turn-run-identity-v1', 'resolveCredentialOrder', 'leaseAccount',
      'publishView', 'publishView', 'agentUsesHostCapacity', 'requestAgentSlot', 'publishView', 'runAgentTurn',
    ]);
  } finally {
    try { await handle.signal('cancel'); release(); await handle.result(); }
    finally { release(); worker.shutdown(); await run; await close(); await native.close(); await server.stop(); }
  }
}, 60_000);
