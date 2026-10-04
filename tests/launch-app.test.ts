import { afterAll, expect, it } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { launchApp, stopEmbeddedTemporal, type AppProcess } from './helpers/browser.js';

// The app walks past KARMAX_PORT to the next free port when it is taken by the
// time the gateway binds. A helper that guessed the port polled a dead URL until
// its deadline (master CI #1462, restore-journey).
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-launch-app-'));
const blocker = net.createServer();
let app: AppProcess | undefined;
afterAll(async () => {
  await app?.stop();
  await app?.stop(); // stopping twice is harmless
  await stopEmbeddedTemporal(home);
  await new Promise((resolve) => blocker.close(resolve));
  fs.rmSync(home, { recursive: true, force: true });
});

it('reaches the app at the port it bound when its preferred port is taken while it boots', async () => {
  const launching = launchApp(home);
  // Long before the gateway binds (Temporal boots first), take the preferred port.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await new Promise<void>((resolve) => blocker.once('error', () => resolve()).listen(48950, '127.0.0.1', () => resolve()));
  app = await launching;
  expect(app.url).not.toBe('http://127.0.0.1:48950');
  expect((await fetch(`${app.url}/api/health/ready`)).ok).toBe(true);
}, 120_000);
