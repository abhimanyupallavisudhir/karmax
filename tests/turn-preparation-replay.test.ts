import { it, expect } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { makeTurnPreparationActivities } from '../src/activities/turn-preparation.js';
import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker, bundleWorkflowCode } from '@temporalio/worker';
import { startDevServer } from '../src/temporal/dev-server.js';
import { makeClient } from '../src/temporal/client.js';

it('prepares one leased turn with one Starting agent publication', async () => {
  const server = await startDevServer({ headless: true, logLevel: 'never' });
  const native = await NativeConnection.connect({ address: server.address });
  const { client, close } = await makeClient({ address: server.address, namespace: server.namespace });
  const taskQueue = 'turn-preparation-test', taskId = 'turn-preparation-fixture';
  const views: any[] = [];
  let running = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const bundle = await bundleWorkflowCode({ workflowsPath: fileURLToPath(new URL('../src/workflows/index.ts', import.meta.url)) });
  const { temporal } = createRequire(import.meta.url)('@temporalio/proto');
  // A leased turn recorded before credential re-listing resolved its allow-list
  // before the turn's id; one recorded by master's re-listing code (334680f3)
  // resolves it after. Both orders must replay.
  for (const fixture of ['turn-preparation-prechange-history.json', 'turn-preparation-relist-history.json'])
    await Worker.runReplayHistory({ workflowBundle: bundle }, temporal.api.history.v1.History.fromObject(
      JSON.parse(fs.readFileSync(new URL(`./fixtures/${fixture}`, import.meta.url), 'utf8'))));
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
