import { it, expect } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker, bundleWorkflowCode } from '@temporalio/worker';
import { startDevServer } from '../src/temporal/dev-server.js';
import { makeClient } from '../src/temporal/client.js';

it.each(['preflight', 'fallback', 'repeated-failure'])('keeps unchanged %s waits out of task history and wakes for cancellation', async mode => {
  const server = await startDevServer({ headless: true, logLevel: 'never' });
  const native = await NativeConnection.connect({ address: server.address });
  const { client, close } = await makeClient({ address: server.address, namespace: server.namespace });
  const taskQueue = 'landing-wait-test';
  const prs = [{ slug: 'test/repo', number: 1, headSha: 'abc', url: 'https://github.com/test/repo/pull/1' }];
  let polls = 0, publications = 0, parks = 0;
  let detail = 'Waiting for required CI.';
  const bundle = await bundleWorkflowCode({ workflowsPath: fileURLToPath(new URL('../src/workflows/index.ts', import.meta.url)) });
  const { temporal } = createRequire(import.meta.url)('@temporalio/proto');
  await Worker.runReplayHistory({ workflowBundle: bundle }, temporal.api.history.v1.History.fromObject(
    JSON.parse(fs.readFileSync(new URL('./fixtures/landing-prechange-history.json', import.meta.url), 'utf8'))));
  const worker = await Worker.create({ connection: native, namespace: server.namespace, taskQueue, workflowBundle: bundle,
    maxCachedWorkflows: 2, maxConcurrentWorkflowTaskExecutions: 2, maxConcurrentActivityTaskExecutions: 2, reuseV8Context: true,
    activities: {
      publishView: async () => { publications++; return 'fence'; }, parkWaitingWorld: async () => { parks++; },
      recordEvent: async () => {}, settleResourceReview: async () => ({ settled: true }), stageResourceCandidates: async () => ({ staged: 0, failed: 0 }), pendingResourceCandidates: async () => 0, unsavedResourceCandidates: async () => [], restoreChildTasks: async () => [], accountPoolSize: async () => 0,
      checkProposal: async () => ({ ready: true }), openPr: async () => prs,
      buildReview: async () => ({ summary: 'fixture', changedFiles: [] }),
      mergeGithubPrs: async (_world: unknown, _prs: unknown, options: { mode?: string }) => {
        if (options.mode === 'preflight') {
          polls++;
          // An unchanged terminal failure on the head whose repair was already
          // charged (LT-12): the ejected task waits for a new run/head/target.
          if (mode === 'repeated-failure') return { status: 'needs-revision', prs, detail,
            repair: { kind: 'ci', preserveAuthorization: true, fingerprint: 'test/repo#1:abc:ci' } };
          return mode === 'preflight' ? { status: 'waiting', prs, detail }
            : { status: 'planned', prs, observationKey: detail, participants: [{ key: 'test/repo#1', owner: 'karmax',
              state: 'ready', domain: 'github:test/repo:main', slug: 'test/repo', number: 1, target: 'main', headSha: 'abc' }] };
        }
        return { status: 'waiting', prs, detail, landingOwner: 'karmax' };
      },
      enqueueMerge: async () => { await client.workflow.getHandle('landing-wait-fixture').signal('mergeGranted'); },
      releaseMerge: async () => {}, cancelMerge: async () => {}, mergeQueuePosition: async () => ({ position: 0, total: 1 }),
      withdrawGithubPrs: async () => ({ withdrawn: [], reconciled: prs }),
      suspendWorldForRecovery: async () => {}, closePrs: async () => {},
    },
  });
  const run = worker.run();
  const handle = await client.workflow.start('softwareDev@1.26.0', { taskQueue, workflowId: 'landing-wait-fixture', args: [{
    taskId: 'landing-wait-fixture', projectId: 'fixture', title: 'Landing fixture', prompt: '',
    project: { repos: ['/fixture'], remote: 'pr' }, githubPollMs: 100,
    recovery: { resumeStage: 'merge', messages: [], prs, world: { id: 'landing-wait-fixture', kind: 'memory', root: '/fixture', branch: 'task', base: 'main' },
      ...(mode === 'repeated-failure' ? { landing: { authorization: 'authorized', validation: 'pending', provider: 'admitting',
        authorizedHeads: { 'test/repo#1': 'abc' }, lastRepairFingerprint: 'test/repo#1:abc:ci', repairAttempts: 1 } } : {}) },
  }] });
  try {
    await expect.poll(() => polls, { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
    const before = { polls, publications, parks };
    await expect.poll(() => polls, { timeout: 20_000 }).toBeGreaterThanOrEqual(before.polls + 3);
    expect(publications).toBe(before.publications);
    expect(parks).toBe(before.parks);
    const watcherId = 'landing-wait-fixture/landing-watch/0';
    const firstRun = (await client.workflow.getHandle(watcherId).describe()).runId;
    const quietHistory = await client.workflow.getHandle(watcherId, firstRun).fetchHistory();
    const quietPolls = quietHistory.events!.filter(event => event.activityTaskScheduledEventAttributes?.activityType?.name === 'mergeGithubPrs');
    const eventsPerPoll = Number(quietPolls[2]!.eventId) - Number(quietPolls[1]!.eventId);
    // Accelerate the rotation test with the watcher's normal webhook wake-up.
    while (polls < 105) {
      const previous = polls;
      await client.workflow.getHandle(watcherId).signal('providerChanged');
      await expect.poll(() => polls, { timeout: 5_000, interval: 10 }).toBeGreaterThan(previous);
    }
    const nextRun = (await client.workflow.getHandle(watcherId).describe()).runId;
    expect(nextRun).not.toBe(firstRun);
    expect(publications).toBe(before.publications);
    expect(parks).toBe(before.parks);
    const history = await client.workflow.getHandle(watcherId, firstRun).fetchHistory();
    const pollEvents = history.events!.filter(event => event.activityTaskScheduledEventAttributes?.activityType?.name === 'mergeGithubPrs');
    expect(pollEvents).toHaveLength(100);
    expect(eventsPerPoll).toBeLessThanOrEqual(11);
    process.stderr.write(JSON.stringify({ mode, eventsPerPoll, eventsPerHour: eventsPerPoll * 120,
      maxWatchHistory: history.events!.length, taskEvents: (await handle.fetchHistory()).events!.length }) + '\n');
    detail = 'Waiting for a different required check.';
    await handle.signal('providerChanged');
    await expect.poll(() => publications, { timeout: 5_000 }).toBeGreaterThan(before.publications);
  } finally {
    try {
      await handle.signal('cancel');
      await expect(handle.result()).resolves.toEqual({ stage: 'cancelled' });
    } finally { worker.shutdown(); await run; await close(); await native.close(); await server.stop(); }
  }
}, 120_000);
