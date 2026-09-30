import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';
import { startDevServer } from '../src/temporal/dev-server.js';
import { findFreePort } from '../src/util/ports.js';

it('serves the API while a startup Docker sweep is stalled (PS-6)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-boot-readiness-'));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\ntouch "$KARMAX_HOME/sweep-started"\nsleep 8\n', { mode: 0o755 });
  const server = await startDevServer({ headless: true, logLevel: 'never' });
  const port = await findFreePort();
  const log = fs.openSync(path.join(home, 'main.log'), 'a');
  const app = spawn(process.execPath, ['--import', 'tsx', '--max-old-space-size=512', 'src/main.ts'], {
    stdio: ['ignore', log, log],
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, KARMAX_HOME: home,
      KARMAX_HOST: '127.0.0.1', KARMAX_PORT: String(port), KARMAX_HOST_LOCAL: '0',
      KARMAX_TEMPORAL_ADDRESS: server.address, KARMAX_TEMPORAL_NAMESPACE: server.namespace,
      KARMAX_TASK_QUEUE: `boot-${port}`, KARMAX_AGENT_PROVIDER: 'mock' },
  });
  const exited = new Promise(resolve => app.once('exit', resolve));
  try {
    await expect.poll(() => fs.existsSync(path.join(home, 'sweep-started')),
      { timeout: 45_000, interval: 100 }).toBe(true);
    await expect.poll(async () => {
      try { return (await fetch(`http://127.0.0.1:${port}/api/health/ready`, { signal: AbortSignal.timeout(500) })).status; }
      catch { return 0; }
    }, { timeout: 1500, interval: 100 }).toBe(200);
  } catch (error) {
    console.error(fs.readFileSync(path.join(home, 'main.log'), 'utf8').slice(-4000));
    throw error;
  } finally {
    app.kill('SIGTERM');
    const kill = setTimeout(() => app.kill('SIGKILL'), 6000);
    await exited;
    clearTimeout(kill);
    await server.stop();
    fs.closeSync(log);
    fs.rmSync(home, { recursive: true, force: true });
  }
}, 60_000);
