import { expect, it } from 'vitest';
import WebSocket from 'ws';
import { bootHarness } from './helpers/harness.js';
import { releaseRevision } from '../src/config/revision.js';

const REVISION = '0123456789abcdef0123456789abcdef01234567';

it('gates API admission and websocket upgrades on runtime readiness while keeping liveness available', async () => {
  const h = await bootHarness('mock');
  let ready = false;
  const previousRevision = process.env.KARMAX_REVISION;
  process.env.KARMAX_REVISION = REVISION;
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
    const readiness = await fetch(`${gateway.url}/api/health/ready`);
    expect(readiness.status).toBe(200);
    // The serving commit, which deploys and the production check compare.
    expect(((await readiness.json()) as { revision?: string }).revision).toBe(REVISION);
    expect(((await (await fetch(`${gateway.url}/api/health/live`)).json()) as { revision?: string }).revision).toBe(REVISION);
    expect((await fetch(`${gateway.url}/api/session`)).status).toBe(200);
    ready = false;
    expect((await fetch(`${gateway.url}/api/session`)).status).toBe(503);
    expect((await fetch(`${gateway.url}/api/health/live`)).status).toBe(200);
    expect(await h.store.listProjects()).toEqual([]);
  } finally {
    if (previousRevision === undefined) delete process.env.KARMAX_REVISION;
    else process.env.KARMAX_REVISION = previousRevision;
    await h.stop();
  }
}, 60_000);

it('reports only a full commit SHA as the release revision', () => {
  expect(releaseRevision({ KARMAX_REVISION: REVISION.toUpperCase() })).toBe(REVISION);
  for (const value of [undefined, '', 'abc123', `${REVISION}0`, 'g'.repeat(40)])
    expect(releaseRevision({ KARMAX_REVISION: value })).toBeUndefined();
});
