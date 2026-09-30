import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import os from 'node:os';
import { Context } from '@temporalio/activity';
import { pingActivities } from '../src/activities/ping.js';
import fs from 'node:fs';
import path from 'node:path';
import type { Client } from '@temporalio/client';
import { startDevServer, DevServer } from '../src/temporal/dev-server.js';
import { makeClient } from '../src/temporal/client.js';
import { WorkerManager } from '../src/temporal/worker-pool.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import { WorkflowRepoLoader } from '../src/packages/repo.js';
import { qualifiedType } from '../src/workflows/names.js';
import { git, gitOrThrow, ensureIdentity } from '../src/world/git.js';

/**
 * PLAN-dynamic-repos §21e — roll a live worker to pick up a newly-loaded
 * package without a restart, and without disturbing an in-flight execution.
 */
describe('live worker refresh (real dev server)', () => {
  let server: DevServer;
  let mgr: WorkerManager;
  let client: Client;
  let closeClient: () => Promise<void>;
  let cacheHome: string;
  let repo: string;

  beforeAll(async () => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-refresh-pkg-'));
    await gitOrThrow(repo, ['init', '-q', '-b', 'main']);
    await ensureIdentity(repo);
    fs.writeFileSync(
      path.join(repo, 'manifest.json'),
      JSON.stringify({ name: 'latecomer', version: '1.0.0', description: '', requires: [], events: [], capabilities: [], ui: [], commands: [], params: [] }),
    );
    fs.writeFileSync(
      path.join(repo, 'workflow.mjs'),
      `export default async function latecomer() { return 'loaded-at-runtime'; }\n`,
    );
    await git(repo, ['add', '-A']);
    await gitOrThrow(repo, ['commit', '-q', '-m', 'v1']);
    cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-refresh-cache-'));

    server = await startDevServer({ headless: true, logLevel: 'never' });
    const conn = { address: server.address, namespace: server.namespace };
    mgr = new WorkerManager(conn);
    await mgr.start(); // built-ins only, no external packages yet
    const c = await makeClient(conn);
    client = c.client;
    closeClient = c.close;
  }, 120_000);

  afterAll(async () => {
    await mgr?.stop();
    await closeClient?.();
    await server?.stop();
    fs.rmSync(cacheHome, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('a package unknown at startup runs after the worker is rolled to include it', async () => {
    // Before load: the type isn't registered anywhere.
    expect(mgr.packages).toEqual([]);

    // Start a built-in execution and hold it open ACROSS the refresh.
    const probe = await client.workflow.start(qualifiedType('versionedProbe', '1.0.0'), {
      taskQueue: TASK_QUEUE,
      workflowId: `probe-across-refresh-${Date.now()}`,
    });

    // Load the package from git and roll the worker to include it.
    const pkg = await new WorkflowRepoLoader(cacheHome).load({ url: repo });
    const type = qualifiedType(pkg.manifest.name, pkg.manifest.version);
    await mgr.refresh([{ type, entryFile: pkg.workflowEntry!, exportName: undefined }]);
    expect(mgr.packages.map((p) => p.type)).toEqual(['latecomer@1.0.0']);

    // The just-loaded workflow now runs on the rolled worker.
    const result = await client.workflow.execute('latecomer@1.0.0', {
      taskQueue: TASK_QUEUE,
      workflowId: `latecomer-${Date.now()}`,
    });
    expect(result).toBe('loaded-at-runtime');

    // The execution started BEFORE the roll survives it and still returns its
    // pinned result (its history replays against the superset bundle).
    await probe.signal('release');
    expect((await probe.result()).version).toBe('1.0.0');
  });
  it('WF-15: an activity survives a worker roll beyond the old one-second grace', async () => {
    let release!: (value: string) => void;
    let started!: () => void;
    const active = new Promise<void>(resolve => { started = resolve; });
    const finish = new Promise<string>(resolve => { release = resolve; });
    let cancelled = false;
    const echo = vi.spyOn(pingActivities, 'echo').mockImplementation(async () => {
      started();
      return Promise.race([finish, Context.current().cancelled.catch(error => { cancelled = true; throw error; })]);
    });
    let probe: Awaited<ReturnType<Client['workflow']['start']>> | undefined;
    try {
      await mgr.refresh(mgr.packages);
      probe = await client.workflow.start('pingWorkflow', {
        taskQueue: TASK_QUEUE, workflowId: `activity-across-refresh-${Date.now()}`, args: ['held'],
      });
      await active;
      await mgr.refresh(mgr.packages);
      await new Promise(resolve => setTimeout(resolve, 1500));
      expect(cancelled).toBe(false);
      release('echo:held');
      await probe.signal('finish');
      expect(await probe.result()).toMatchObject({ started: 'held' });
    } finally {
      release('echo:held');
      await probe?.terminate('test cleanup').catch(() => undefined);
      echo.mockRestore();
    }
  }, 60_000);

});
