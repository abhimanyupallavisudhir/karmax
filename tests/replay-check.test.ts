import { expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker, bundleWorkflowCode } from '@temporalio/worker';
import { startDevServer } from '../src/temporal/dev-server.js';
import { makeClient } from '../src/temporal/client.js';
import { replayRunningWorkflows } from '../src/ops/replay-check.js';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A running workflow replays its recorded history under whatever code the next
// worker loads. `deploy/karmax update` replays every running workflow under the
// candidate first, so a release that would wedge one is refused (WF-34).
it('replays every running workflow under a bundle and names each one it cannot replay', async () => {
  const server = await startDevServer({ headless: true, logLevel: 'never' });
  const native = await NativeConnection.connect({ address: server.address });
  const { client, close } = await makeClient({ address: server.address, namespace: server.namespace });
  const bundle = (name: string) => bundleWorkflowCode({
    workflowsPath: fileURLToPath(new URL(`./fixtures/replay-check-${name}.ts`, import.meta.url)),
  });
  const taskQueue = 'replay-check';
  try {
    // The updater runs the check in the new image before anything has started
    // with it: the app's database URL file does not exist yet on the first
    // upgrade to a release with its own role, and the check needs only Temporal.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-replay-cli-'));
    const cli = spawnSync(process.execPath, ['--import', 'tsx', 'src/scripts/replay-check.ts'], { encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, KARMAX_HOME: home, KARMAX_TEMPORAL_ADDRESS: server.address, KARMAX_TEMPORAL_NAMESPACE: server.namespace,
        KARMAX_DATABASE_URL_FILE: path.join(home, 'missing', 'database_url') } });
    fs.rmSync(home, { recursive: true, force: true });
    expect(cli.status, cli.stderr).toBe(0);
    expect(cli.stdout).toContain('Replayed all 0 running workflows under this release.');

    const recorded = await bundle('recorded');
    const worker = await Worker.create({
      connection: native, namespace: server.namespace, taskQueue, workflowBundle: recorded,
      maxCachedWorkflows: 2, maxConcurrentWorkflowTaskExecutions: 2, maxConcurrentActivityTaskExecutions: 2,
      activities: { step: async () => 'done', blob: async () => 'x'.repeat(1_500_000) },
    });
    const run = worker.run();
    try {
      const running = await Promise.all(['parked', 'steady', 'retired', 'bulky'].map(type =>
        client.workflow.start(type, { taskQueue, workflowId: `${type}-1` })));
      await client.workflow.execute('finishes', { taskQueue, workflowId: 'finished-1' });
      // Each has run its activity and parked, with no pending work.
      for (const handle of running) {
        await expect.poll(async () => {
          const { events } = await handle.fetchHistory();
          return (events ?? []).some(event => event.activityTaskCompletedEventAttributes)
            && !(await handle.describe()).raw.pendingWorkflowTask;
        }, { timeout: 20_000 }).toBe(true);
      }
    } finally {
      worker.shutdown();
      await run;
    }

    // The code that recorded them replays all of them; a finished one is not checked.
    expect(await replayRunningWorkflows(client, recorded)).toEqual({ checked: 4, failures: [] });

    const result = await replayRunningWorkflows(client, await bundle('reordered'));
    expect(result.checked).toBe(4);
    expect(result.failures.map(f => [f.workflowId, f.workflowType])).toEqual([['parked-1', 'parked'], ['retired-1', 'retired']]);
    expect(result.failures[0]!.message).toMatch(/nondetermin/i);
  } finally {
    await close();
    await native.close();
    await server.stop();
  }
}, 120_000);
