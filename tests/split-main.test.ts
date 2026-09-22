import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { startDevServer } from '../src/temporal/dev-server.js';
import { findFreePort } from '../src/util/ports.js';

const postgres = process.env.KARMAX_TEST_POSTGRES_URL;
const test = postgres && process.platform === 'linux' ? it : it.skip;

test('serves and executes tasks across gateway/worker processes, survives restart, and detects worker loss', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-split-main-'));
  const schema = `main_${crypto.randomUUID().replaceAll('-', '')}`;
  const target = new URL(postgres!);
  target.searchParams.set('options', `-csearch_path=${schema}`);
  const admin = new Pool({ connectionString: postgres });
  let store: Store | undefined;
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  let app: ChildProcess | undefined;
  let exit: Promise<number | null> | undefined;
  let workerPid: number | undefined;
  const log = fs.openSync(path.join(home, 'main.log'), 'a');
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    server = await startDevServer({ headless: true, logLevel: 'never' });
    const port = await findFreePort();
    const base = `http://127.0.0.1:${port}`;
    const queue = `split-main-${crypto.randomUUID()}`;
    const boot = async () => {
      app = spawn(process.execPath, ['--import', 'tsx', '--max-old-space-size=512', 'src/main.ts'], {
        cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['ignore', log, log],
        env: { PATH: process.env.PATH, HOME: process.env.HOME, KARMAX_HOME: home,
          KARMAX_HOST: '127.0.0.1', KARMAX_PORT: String(port), KARMAX_HOST_LOCAL: '0',
          KARMAX_DATABASE_URL: target.href, KARMAX_TEMPORAL_ADDRESS: server!.address,
          KARMAX_TEMPORAL_NAMESPACE: server!.namespace, KARMAX_TASK_QUEUE: queue,
          KARMAX_AGENT_PROVIDER: 'mock', KARMAX_WORKER_MODE: 'process' },
      });
      exit = new Promise(resolve => app!.once('exit', code => resolve(code)));
      await expect.poll(async () => {
        if (app!.exitCode !== null || app!.signalCode !== null)
          throw new Error(fs.readFileSync(path.join(home, 'main.log'), 'utf8').slice(-8000));
        try { return (await fetch(`${base}/api/health/ready`, { signal: AbortSignal.timeout(1000) })).status; }
        catch { return 0; }
      }, { timeout: 45_000, interval: 100 }).toBe(200);
      const children = fs.readFileSync(`/proc/${app.pid}/task/${app.pid}/children`, 'utf8').trim().split(/\s+/);
      workerPid = children.map(Number).find(pid => {
        try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('activity-worker-main.ts'); }
        catch { return false; }
      });
      expect(workerPid).toBeDefined();
    };
    await boot();
    store = await Store.create(target.href);
    const project = (await store.listProjects())[0]!;
    const { token } = await new TokenAuthority(store).mint({
      taskId: 'isolated-test-driver', profileId: 'test', principal: 'system:test',
      projectId: project.id, organizationId: project.organizationId,
      ceiling: ['task:create', 'task:read'], grantorCaps: ['task:create', 'task:read'],
    });
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const response = await fetch(`${base}/api/projects/${project.id}/tasks`, {
      method: 'POST', headers, body: JSON.stringify({ title: 'Split process script',
        workflow: 'script-exec', prompt: 'Run the isolated smoke script', command: 'printf split-main-ok' }),
    });
    const task = await response.json() as { id: string };
    expect(response.status, JSON.stringify(task)).toBe(200);
    const read = async () => (await fetch(`${base}/api/tasks/${task.id}`, { headers })).json() as Promise<{ stage: string; messages: Array<{ text: string }> }>;
    await expect.poll(async () => (await read()).stage, { timeout: 20_000 }).toBe('review');
    const reviewed = await read();
    expect(reviewed.messages.some(message => message.text.includes('split-main-ok')), JSON.stringify(reviewed)).toBe(true);
    // A stopped execution event loop must not prevent the primary from serving
    // task pages or health requests. Resume before normal shutdown.
    process.kill(workerPid!, 'SIGSTOP');
    try {
      const taskPage = await fetch(`${base}/api/tasks/${task.id}`, { headers, signal: AbortSignal.timeout(2000) });
      expect(taskPage.status).toBe(200);
      expect((await fetch(`${base}/api/health/live`, { signal: AbortSignal.timeout(2000) })).status).toBe(200);
    } finally { process.kill(workerPid!, 'SIGCONT'); }
    app!.kill('SIGTERM');
    expect(await exit).toBe(0);
    expect(await store.kvGet('runtime:active')).toBeUndefined();
    await boot();
    expect((await read()).stage).toBe('review');
    process.kill(workerPid!, 'SIGKILL');
    await expect.poll(() => app!.exitCode, { timeout: 10_000 }).toBe(1);
  } finally {
    if (app && app.exitCode === null && app.signalCode === null) app.kill('SIGKILL');
    await exit;
    await store?.close();
    await server?.stop();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    fs.closeSync(log);
    fs.rmSync(home, { recursive: true, force: true });
  }
}, 120_000);
