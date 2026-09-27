import { afterEach, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { makeCoreActivities } from '../src/activities/core.js';

let store: Store;
afterEach(async () => { vi.restoreAllMocks(); await store?.close(); });
async function fixture() {
  store = await Store.create(':memory:');
  const worlds = new WorldRegistry();
  const world = await worlds.create('memory', { taskId: 'bounds', base: 'main' });
  vi.spyOn(worlds, 'open').mockResolvedValue(world);
  const core = makeCoreActivities({ store, worlds, adapters: new Map(), profiles: new ProfileResolver(store, 'mock') });
  return { core, world };
}

it('RT-9 bounds script output in the activity result and marks truncation', async () => {
  const { core, world } = await fixture();
  vi.spyOn(world, 'exec').mockResolvedValue({ code: 9, stdout: 'x'.repeat(300_000), stderr: 'last diagnostic' });
  const result = await core.runScript({ taskId: 'bounds', worldHandle: world.handle, command: 'fixture' });
  expect(result.code).toBe(9);
  expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(64 * 1024);
  expect(result.output).toContain('truncated');
  expect(result.output).toContain('last diagnostic');
});

it('RT-9/WD-20 bounds repository-free changed files and states the omission', async () => {
  const { core, world } = await fixture();
  vi.spyOn(world, 'listFiles').mockResolvedValue(Array.from({ length: 20_000 }, (_, i) => `${i}-${'x'.repeat(200)}`));
  const result = await core.buildReview(world.handle, 'main');
  expect(result.changedFiles.length).toBeLessThanOrEqual(1000);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(128 * 1024);
  expect(result.summary).toContain(`Showing ${result.changedFiles.length};`);
});
