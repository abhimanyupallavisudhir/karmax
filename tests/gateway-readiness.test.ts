import { expect, it } from 'vitest';
import WebSocket from 'ws';
import { bootHarness } from './helpers/harness.js';

it('gates API admission and websocket upgrades on runtime readiness while keeping liveness available', async () => {
  const h = await bootHarness('mock');
  let ready = false;
  try {
    const gateway = await h.startGateway({ runtimeReady: () => ready });
    expect((await fetch(`${gateway.url}/api/health/live`)).status).toBe(200);
    expect((await fetch(`${gateway.url}/api/health/ready`)).status).toBe(503);
    expect((await fetch(`${gateway.url}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Too early' }),
    })).status).toBe(503);
    const socket = new WebSocket(gateway.url.replace('http:', 'ws:') + '/ws');
    await expect(new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    })).rejects.toThrow();
    socket.terminate();
    ready = true;
    expect((await fetch(`${gateway.url}/api/health/ready`)).status).toBe(200);
    expect((await fetch(`${gateway.url}/api/session`)).status).toBe(200);
    ready = false;
    expect((await fetch(`${gateway.url}/api/session`)).status).toBe(503);
    expect((await fetch(`${gateway.url}/api/health/live`)).status).toBe(200);
    expect(await h.store.listProjects()).toEqual([]);
  } finally { await h.stop(); }
}, 60_000);
