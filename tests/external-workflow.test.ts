import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import type { Client } from '@temporalio/client';
import { startDevServer, DevServer } from '../src/temporal/dev-server.js';
import { makeClient } from '../src/temporal/client.js';
import { makeWorker, WorkerHandle } from '../src/temporal/worker.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import { WorkflowRepoLoader } from '../src/packages/repo.js';
import { PackageStore } from '../src/packages/store.js';
import { buildVersionedBundle } from '../src/packages/bundle.js';
import { qualifiedType } from '../src/workflows/names.js';
import { git, gitOrThrow, ensureIdentity } from '../src/world/git.js';

/**
 * PLAN-dynamic-repos §21c — the payoff: a workflow package that lives in a git
 * repo (not the app bundle) has its *code* loaded, compiled into the
 * deterministic sandbox under a version-qualified type, and run end-to-end,
 * driving a platform activity — all while the built-in workflows still work.
 */
describe('external workflow package: load from git → bundle → run (real dev server)', () => {
  let server: DevServer;
  let worker: WorkerHandle;
  let workerRun: Promise<void>;
  let client: Client;
  let closeClient: () => Promise<void>;
  let cacheHome: string;
  let repo: string;

  beforeAll(async () => {
    // A workflow package in its own git repo: manifest + durable code that
    // drives the platform `echo` activity (stands in for a real agent turn).
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-extpkg-'));
    await gitOrThrow(repo, ['init', '-q', '-b', 'main']);
    await ensureIdentity(repo);
    fs.writeFileSync(
      path.join(repo, 'manifest.json'),
      JSON.stringify({
        name: 'greeter', version: '1.0.0', description: 'external greeter', requires: [], events: [], capabilities: [], ui: [], commands: [], params: [],
        roles: [{ name: 'do', label: 'Do', promptTemplate: '{{prompt}}' }],
        stages: [{ key: 'setup', label: 'Setup' }, { key: 'done', label: 'Done' }],
      }),
    );
    fs.writeFileSync(
      path.join(repo, 'workflow.mjs'),
      `import { proxyActivities } from '@temporalio/workflow';\n` +
        `const act = proxyActivities({ startToCloseTimeout: '10s' });\n` +
        `export default async function greeter(name) {\n` +
        `  const echoed = await act.echo(name ?? 'world');\n` +
        `  return { ran: 'external', echoed };\n` +
        `}\n`,
    );
    await git(repo, ['add', '-A']);
    await gitOrThrow(repo, ['commit', '-q', '-m', 'greeter v1']);

    cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-extcache-'));
    const store = new PackageStore();
    const pkg = await new WorkflowRepoLoader(cacheHome).load({ url: repo }, store);

    // Fold the loaded package's code into the worker's bundle under its
    // version-qualified type, alongside the built-in workflows.
    const type = qualifiedType(pkg.manifest.name, pkg.manifest.version); // greeter@1.0.0
    const bundle = await buildVersionedBundle([{ type, entryFile: pkg.workflowEntry!, exportName: undefined }]);

    server = await startDevServer({ headless: true, logLevel: 'never' });
    const conn = { address: server.address, namespace: server.namespace };
    worker = await makeWorker(conn, {}, { workflowBundle: bundle });
    workerRun = worker.run();
    const c = await makeClient(conn);
    client = c.client;
    closeClient = c.close;
  }, 120_000);

  afterAll(async () => {
    worker?.shutdown();
    await workerRun?.catch(() => {});
    await closeClient?.();
    await server?.stop();
    fs.rmSync(cacheHome, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('runs the git-loaded workflow end-to-end, driving a platform activity', async () => {
    const result = await client.workflow.execute('greeter@1.0.0', {
      taskQueue: TASK_QUEUE,
      workflowId: `greeter-${Date.now()}`,
      args: ['Ada'],
    });
    expect(result).toEqual({ ran: 'external', echoed: 'echo:Ada' });
  });

  it('the built-in workflows still work in the same augmented worker', async () => {
    // A bundled string-named export survives `export *` into the generated entry.
    const probe = await client.workflow.start(qualifiedType('versionedProbe', '1.0.0'), {
      taskQueue: TASK_QUEUE,
      workflowId: `probe-coexist-${Date.now()}`,
    });
    await probe.signal('release');
    expect((await probe.result()).version).toBe('1.0.0');
  });
});
