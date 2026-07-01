import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import type { Client } from '@temporalio/client';
import { startDevServer, DevServer } from '../src/temporal/dev-server.js';
import { makeClient } from '../src/temporal/client.js';
import { WorkerManager } from '../src/temporal/worker-pool.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import { WorkflowRepoLoader } from '../src/packages/repo.js';
import { PackageStore } from '../src/packages/store.js';
import { WorkflowManager } from '../src/packages/manager.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxApi } from '../src/platform/api.js';
import { git, gitOrThrow, ensureIdentity } from '../src/world/git.js';

/**
 * PLAN-dynamic-repos §21d — the whole thing reachable from the product: install
 * a workflow from a git repo through the API, see it listed, then create and run
 * a task on it via the normal task-creation path.
 */
describe('install a workflow from git and run a task on it (real dev server)', () => {
  let server: DevServer;
  let mgr: WorkerManager;
  let client: Client;
  let closeClient: () => Promise<void>;
  let api: KarmaxApi;
  let token: string;
  let projectId: string;
  let cacheHome: string;
  let repo: string;

  beforeAll(async () => {
    // A package whose durable code echoes the task prompt via a platform activity.
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-note-pkg-'));
    await gitOrThrow(repo, ['init', '-q', '-b', 'main']);
    await ensureIdentity(repo);
    fs.writeFileSync(
      path.join(repo, 'manifest.json'),
      JSON.stringify({
        name: 'note', version: '1.0.0', description: 'echoes the prompt', requires: [], events: [], capabilities: [], ui: [], commands: [],
        params: [{ name: 'prompt', type: 'text', bind: 'prompt', scopes: ['task'] }],
      }),
    );
    fs.writeFileSync(
      path.join(repo, 'workflow.mjs'),
      `import { proxyActivities } from '@temporalio/workflow';\n` +
        `const act = proxyActivities({ startToCloseTimeout: '10s' });\n` +
        `export default async function note(input) {\n` +
        `  const echoed = await act.echo(input?.prompt ?? '');\n` +
        `  return { ran: 'external', echoed };\n` +
        `}\n`,
    );
    await git(repo, ['add', '-A']);
    await gitOrThrow(repo, ['commit', '-q', '-m', 'note v1']);

    cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-note-cache-'));
    server = await startDevServer({ headless: true, logLevel: 'never' });
    const conn = { address: server.address, namespace: server.namespace };
    mgr = new WorkerManager(conn);
    await mgr.start();
    const c = await makeClient(conn);
    client = c.client;
    closeClient = c.close;

    const store = new Store(':memory:');
    const tokens = new TokenAuthority();
    const workflows = new WorkflowManager(mgr, new WorkflowRepoLoader(cacheHome), PackageStore.withBundled());
    api = new KarmaxApi({ store, client, taskQueue: TASK_QUEUE, tokens, workflows });
    projectId = store.createProject('P', { defaultBase: 'main', defaultTarget: 'main' }).id;
    token = tokens.mint({ taskId: 't', profileId: 'do', principal: 'user:a', ceiling: ['create-task', 'edit-workflow', 'read-task'], grantorCaps: ['create-task', 'edit-workflow', 'read-task'] }).token;
  }, 120_000);

  afterAll(async () => {
    await mgr?.stop();
    await closeClient?.();
    await server?.stop();
    fs.rmSync(cacheHome, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('installs from git, lists it as external, and runs a task on it end-to-end', async () => {
    const installed = await api.installWorkflow(token, { url: repo });
    expect(installed).toEqual({ name: 'note', version: '1.0.0' });

    const listed = api.listWorkflows(token).find((w) => w.name === 'note');
    expect(listed).toMatchObject({ name: 'note', latest: '1.0.0', source: 'external' });
    // built-ins are still listed alongside it
    expect(api.listWorkflows(token).some((w) => w.name === 'software-dev' && w.source === 'bundled')).toBe(true);

    // Create a task on the installed workflow through the normal path; it runs.
    const task = await api.createTask(token, { projectId, workflow: 'note', prompt: 'hello' });
    expect(task.workflow).toBe('note');
    const result = await client.workflow.getHandle(task.id).result();
    expect(result).toEqual({ ran: 'external', echoed: 'echo:hello' });
  });

  it('refuses to install over a built-in workflow name', async () => {
    await expect(api.installWorkflow(token, { url: repo, name: 'software-dev' })).rejects.toThrow(/built-in/);
  });
});
