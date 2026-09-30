import { afterAll, beforeAll, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Gateway } from '../src/gateway/server.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { WorldRegistry } from '../src/world/registry.js';
import { findFreePortFrom } from '../src/util/ports.js';

let home: string;
let store: Store;
let gateway: Gateway;
let base: string;
let close: () => Promise<void>;
let taskId: string;

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-terminal-tickets-'));
  store = (await Store.create(':memory:'));
  const project = (await store.createProject('Terminal tickets'));
  taskId = (await store.createTask({ projectId: project.id, title: 'Attach', workflow: 'software-dev',
    workflowVersion: '1.0.0', params: { prompt: 'x' } })).id;
  gateway = (await Gateway.create({ store, bus: new KarmaxBus(), tokens: new TokenAuthority(),
    contributions: new ContributionRegistry(), overlays: new Overlays(), client: {} as any, api: {} as any,
    taskQueue: 'test', staticDir: home, worlds: new WorldRegistry(), agentInfo: { provider: 'mock', reason: 'test' },
  } as any));
  const running = await gateway.listen(await findFreePortFrom(48_600));
  base = running.url;
  close = running.close;
});

afterAll(async () => {
  await close?.();
  (await store?.close());
  fs.rmSync(home, { recursive: true, force: true });
});

// Each outstanding ticket keeps its session in memory for five minutes, so one
// session minting in a loop must not grow the gateway without bound (PS-14c).
it('caps the terminal tickets one session can hold, keeping the newest', async () => {
  const token = (await (await fetch(`${base}/api/session`)).json() as any).token;
  const tickets: string[] = [];
  for (let i = 0; i < 20; i++) {
    const response = await fetch(`${base}/api/tasks/${taskId}/terminal-ticket`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    tickets.push((await response.json() as any).ticket);
  }
  const live = (gateway as any).terminalTickets as Map<string, unknown>;
  expect(live.size).toBeLessThanOrEqual(8);
  expect(live.has(tickets.at(-1)!)).toBe(true);
  expect(live.has(tickets[0]!)).toBe(false);
});
