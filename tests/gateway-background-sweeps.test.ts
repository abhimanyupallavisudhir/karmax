import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Gateway } from '../src/gateway/server.js';
import { KarmaxApi } from '../src/platform/api.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { WorldRegistry } from '../src/world/registry.js';
import { findFreePortFrom } from '../src/util/ports.js';
import type { ServiceConnections } from '../src/integrations/service-connections.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

// The gateway's connection sweep runs every few seconds with nobody awaiting
// it. While PostgreSQL restarted under the running app (a deploy, 2026-11-17)
// its first read failed with 57P03 and the rejection escaped unhandled
// (tavya-error d035db8d7325aeb6). A failed sweep is retried by the next tick.
it('rides out a connection sweep that fails because the database is unavailable', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-sweeps-'));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  const store = await Store.create(':memory:');
  cleanups.push(() => store.close());
  const tokens = new TokenAuthority();
  const client = { workflow: { getHandle: () => ({ signal: async () => {}, query: async () => ({}) }) } } as any;
  const worlds = new WorldRegistry();
  const api = new KarmaxApi({ store, tokens, client, worlds, taskQueue: 'test', contentDir: home });
  let outage = true;
  const reconcile = vi.fn(async () => {
    if (outage) throw Object.assign(new Error('the database system is shutting down'), { code: '57P03' });
  });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  cleanups.push(() => { process.off('unhandledRejection', onUnhandled); });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  cleanups.push(() => warn.mockRestore());

  const gateway = await Gateway.create({ store, tokens, api, client, worlds,
    serviceConnections: { reconcile } as unknown as ServiceConnections,
    bus: new KarmaxBus(), contributions: new ContributionRegistry(), overlays: new Overlays(),
    taskQueue: 'test', staticDir: home, agentInfo: { provider: 'mock', reason: 'test' } } as any);
  const running = await gateway.listen(await findFreePortFrom(49_400));
  cleanups.push(() => running.close());

  await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(unhandled).toEqual([]);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('[connections]'), expect.stringContaining('shutting down'));

  // The failed sweep let go of its slot: the next one runs.
  outage = false;
  (gateway as unknown as { sweepConnections(): void }).sweepConnections();
  await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2));
});
