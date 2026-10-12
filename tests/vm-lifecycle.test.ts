import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';
import { RunnerPoolService, WorldLifecycleManager } from '../src/world/runners.js';
import type { WorldHandle } from '../src/world/types.js';

/**
 * The lifecycle sweep with a VM provider (Fly.io, Hetzner): a resized world
 * keeps its disk instead of hibernating, the provider's own prices and disk
 * hours become usage rows, and its upkeep runs once per connected organization.
 */
const stores: Store[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const store of stores.splice(0)) await store.close(); });

async function fixture() {
  const store = await Store.create(':memory:'); stores.push(store);
  const organization = await store.createOrganization({ name: 'VM', ownerUserId: 'owner' });
  const project = await store.createProject('Big data', { worldProvider: 'fly' }, organization.id);
  const task = await store.createTask({ projectId: project.id, title: 'Rebuild the database', workflow: 'software-dev',
    workflowVersion: '1.0.0', params: { prompt: 'x' } as any });
  await store.upsertWorldProviderConnection({ organizationId: organization.id, provider: 'fly', credentialHandle: 'test:fly', enabled: true });
  const handle = await store.registerWorld({ kind: 'fly', id: task.id, root: '/home/user/karmax', branch: 'b', base: 'main',
    meta: { computer: { diskGb: 100 }, machine: { cpu: 2, memoryMb: 2048, diskGb: 100 } } } as any, project.id) as WorldHandle;
  await store.setWorldState(handle, 'parked');
  const provider = {
    kind: 'fly', parkable: true,
    resize: vi.fn(async (_handle: WorldHandle, to: { diskGb?: number }) => ({ disk: 'grown' as const, restart: false,
      machine: { cpu: 2, memoryMb: 2048, diskGb: to.diskGb! } })),
    destroy: vi.fn(async () => {}),
    housekeep: vi.fn(async () => {}),
    listUsageEvents: vi.fn(async () => ({ events: [
      { id: 'm1:1000', sandboxId: 'app', taskId: task.id, organizationId: organization.id, startedAt: 1_000, endedAt: 601_000,
        activeMs: 600_000, cpu: 2, memoryMb: 2048, costMicros: 3_100 },
      { id: 'vol1:0', sandboxId: 'app', taskId: task.id, organizationId: organization.id, kind: 'disk' as const, startedAt: 0,
        endedAt: 3_600_000, activeMs: 3_600_000, cpu: 0, memoryMb: 0, diskGb: 100, costMicros: 20_833 },
    ] })),
  };
  const worlds = new WorldRegistry();
  worlds.register(provider as any);
  const checkpoint = vi.fn(async () => { throw new Error('a VM world never needs a checkpoint to change size'); });
  const notices: string[] = [];
  const lifecycle = new WorldLifecycleManager(store, worlds, { checkpoint, addNotice: async (_id: string, notice: string) => { notices.push(notice); } } as any);
  return { store, organization, project, task, handle, provider, lifecycle, notices, checkpoint };
}

it('grows a parked VM world’s disk in place instead of hibernating it for a new size', async () => {
  const f = await fixture();
  await f.store.patchTaskParams(f.task.id, { computer: { diskGb: 150 } });
  await f.lifecycle.sweep(Date.now());
  expect(f.provider.resize).toHaveBeenCalledWith(expect.objectContaining({ id: f.task.id }), expect.objectContaining({ diskGb: 150 }));
  expect(f.provider.destroy).not.toHaveBeenCalled();
  expect(f.checkpoint).not.toHaveBeenCalled();
  expect(await f.store.worldState(f.task.id)).toBe('parked');
  expect((await f.store.currentWorld(f.task.id))?.meta).toMatchObject({ computer: { diskGb: 150 }, machine: { diskGb: 150 } });
  expect(f.notices).toEqual([expect.stringMatching(/resized to .*150 GB disk, in place: every file is where you left it/)]);
  const events = await f.store.eventsSince(f.task.id, 0);
  expect(events.map((event) => event.type)).toContain('world.resized');
  // Recorded: the next sweep has nothing left to do.
  await f.lifecycle.sweep(Date.now());
  expect(f.provider.resize).toHaveBeenCalledTimes(1);
});

it('books a VM provider’s own prices, with its volume hours as disk usage', async () => {
  const f = await fixture();
  await f.lifecycle.sweep(Date.now());
  const summary = await f.store.usageSummary(f.organization.id);
  expect(summary.byKind).toEqual({ 'world.active': 3_100, 'world.disk': 20_833 });
  expect(summary.byProvider).toEqual({ fly: 23_933 });
});

it('runs each VM provider’s upkeep for every organization connected to it', async () => {
  const f = await fixture();
  await f.lifecycle.sweep(Date.now());
  expect(f.provider.housekeep).toHaveBeenCalledWith(f.organization.id);
});

it('never bills a VM world’s runner lease: its provider reports the billable time', async () => {
  const f = await fixture();
  const runners = new RunnerPoolService(f.store);
  const lease = await runners.acquire({ project: f.project, taskId: f.task.id, worldId: f.task.id, provider: 'fly' });
  await runners.release(lease.leaseId, 'fly');
  expect((await f.store.usageSummary(f.organization.id)).events).toBe(0);
});
