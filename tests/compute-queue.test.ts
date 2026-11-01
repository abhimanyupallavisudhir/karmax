// The compute queue, the account budget's disk and parked machines, the waker
// and stuck wakes (wiki features/managed-compute § Queue, § Budget;
// features/compute-routing § Stuck wakes).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';
import { STUCK_WAKE_NOTICE, WorldLifecycleManager } from '../src/world/runners.js';
import { accountKey, dequeue, enqueue, ordered, RESERVE_AFTER_MS, WAITER_STALE_MS, WAKE_RELOCATE_AFTER_MS, waiters, wakeFullKey, type Waiter } from '../src/world/compute-queue.js';
import { accountRoom, accountUse } from '../src/world/account-room.js';
import { BLIND_SIGNAL_GAP_MS, wakeComputeQueue } from '../src/world/compute-waker.js';
import { MANAGED_COMPUTE } from '../src/world/connections.js';
import type { WorldHandle } from '../src/world/types.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const store = await Store.create(':memory:', { hosted: true });
  cleanups.push(() => store.close());
  const acme = await store.createOrganization({ name: 'Acme', ownerUserId: 'a' });
  const other = await store.createOrganization({ name: 'Other', ownerUserId: 'o' });
  const projects = { [acme.id]: await store.createProject('Acme', { worldProvider: 'any' }, acme.id),
    [other.id]: await store.createProject('Other', { worldProvider: 'any' }, other.id) };
  const task = async (organizationId: string, priority?: number) => (await store.createTask({ projectId: projects[organizationId]!.id, title: 'T',
    workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'x', ...(priority !== undefined ? { priority } : {}) } as any })).id;
  /** A world that exists on a provider account (managed unless `own`). */
  const world = async (organizationId: string, kind: string, state: 'ready' | 'parked', diskGb: number, own = false) => {
    const id = await task(organizationId);
    const handle = await store.registerWorld({ kind, id, root: '/home/user', branch: 'main', base: 'main',
      meta: { ...(own ? {} : { funding: 'managed' }), machine: { cpu: 2, memoryMb: 4096, diskGb } } } as any, projects[organizationId]!.id) as WorldHandle;
    await store.setWorldState(handle, state);
    return handle;
  };
  return { store, acme: acme.id, other: other.id, projects, task, world };
}

const waiter = (taskId: string, organizationId: string, since: number, priority = 2): Waiter =>
  ({ taskId, organizationId, since, priority, accounts: { 'installation:aws': since } });

describe('the queue', () => {
  it('serves who waited first across organizations, and by priority within one, never letting priority jump another organization', () => {
    const line = ordered([waiter('a1', 'A', 1), waiter('b1', 'B', 2), waiter('a2', 'A', 3, 4), waiter('b2', 'B', 4)], 'installation:aws');
    // A's urgent a2 takes A's earliest place; B's places stay B's.
    expect(line.map((value) => value.taskId)).toEqual(['a2', 'b1', 'a1', 'b2']);
  });

  it('keeps a waiter\'s place, joins after everyone within one millisecond, and drops one that stopped asking', async () => {
    const f = await fixture();
    const [first, second] = [await f.task(f.acme), await f.task(f.other)];
    const key = accountKey(MANAGED_COMPUTE, 'aws');
    await enqueue(f.store, { taskId: first, organizationId: f.acme, account: key }, 1_000);
    await enqueue(f.store, { taskId: second, organizationId: f.other, account: key }, 1_000);
    await enqueue(f.store, { taskId: first, organizationId: f.acme, account: key }, 2_000);
    expect(ordered(await waiters(f.store, 2_000), key).map((value) => [value.taskId, value.since])).toEqual([[first, 1_000], [second, 1_001]]);
    // Not asked for this long: gone.
    expect((await waiters(f.store, 1_001 + WAITER_STALE_MS)).map((value) => value.taskId)).toEqual([first]);
    await dequeue(f.store, first, 2_001);
    expect(await waiters(f.store, 2_002)).toEqual([expect.objectContaining({ taskId: second })]);
  });
});

describe('admission by the account\'s budget and queue', () => {
  it('counts parked worlds\' disks, and on Google Cloud their machines, against the account', async () => {
    const f = await fixture();
    await f.world(f.acme, 'aws', 'parked', 100);
    await f.world(f.acme, 'aws', 'ready', 100);
    await f.world(f.acme, 'gcp', 'parked', 50);
    // Home disks plus each machine's 20 GB root disk.
    expect(await accountUse(f.store, 'aws', null)).toMatchObject({ diskGb: 240, machines: 0 });
    expect(await accountUse(f.store, 'gcp', null)).toMatchObject({ diskGb: 70, machines: 1 });
    const room = (provider: string, pool: Record<string, number>, diskGb = 20) => accountRoom(f.store, { provider, managed: true, pool },
      { organizationId: f.acme, cpu: 2, diskGb });
    // A new 50 GB world takes 70 (its root disk too): 310 of 300.
    expect(await room('aws', { diskGb: 300 }, 50)).toMatchObject({ reason: '240 of its 300 GB of disk taken' });
    expect(await room('aws', { diskGb: 300 }, 40)).toBeUndefined();
    expect(await room('gcp', { machines: 1 })).toMatchObject({ reason: 'all 1 in use' });
  });

  it('lets a newer machine through when the one ahead does not fit the free room, until that one has waited long enough to keep its place', async () => {
    const f = await fixture();
    const big = await f.task(f.other);
    const small = await f.task(f.acme);
    const account = { provider: 'aws', managed: true, pool: { cpu: 4 } };
    // The big one asks for 8 CPUs of 4: it waits.
    expect(await accountRoom(f.store, account, { organizationId: f.other, taskId: big, cpu: 8 }, 10_000)).toBeDefined();
    // A small one fits now and the big one could not use the room anyway: in.
    expect(await accountRoom(f.store, account, { organizationId: f.acme, taskId: small, cpu: 2 }, 20_000)).toBeUndefined();
    // Once the big one has waited RESERVE_AFTER_MS, the room is kept for it.
    expect(await accountRoom(f.store, account, { organizationId: f.acme, taskId: small, cpu: 2 }, 10_000 + RESERVE_AFTER_MS))
      .toMatchObject({ reason: '1 waiting ahead' });
  });

  it('keeps strict order on an account whose budget is unknown, its own included', async () => {
    const f = await fixture();
    const first = await f.task(f.acme);
    const later = await f.task(f.acme);
    const own = { provider: 'hetzner', managed: false };
    // Nothing known and nobody waiting: the provider decides.
    expect(await accountRoom(f.store, own, { organizationId: f.acme, taskId: later })).toBeUndefined();
    // Hetzner refused the first: it waits, and no later task of the organization passes it.
    await enqueue(f.store, { taskId: first, organizationId: f.acme, account: accountKey(f.acme, 'hetzner') });
    expect(await accountRoom(f.store, own, { organizationId: f.acme, taskId: later }))
      .toMatchObject({ message: 'A task is waiting ahead of this one for this organization\'s Hetzner Cloud account; waiting its turn.' });
    expect(await accountRoom(f.store, own, { organizationId: f.acme, taskId: first })).toBeUndefined();
    // Another organization's own account is its own queue.
    expect(await accountRoom(f.store, own, { organizationId: f.other, taskId: await f.task(f.other) })).toBeUndefined();
  });

  it('puts a higher-priority task of the organization ahead of its own earlier ones', async () => {
    const f = await fixture();
    const early = await f.task(f.acme, 1);
    const urgent = await f.task(f.acme, 4);
    const own = { provider: 'hetzner', managed: false };
    await enqueue(f.store, { taskId: early, organizationId: f.acme, account: accountKey(f.acme, 'hetzner') });
    expect(await accountRoom(f.store, own, { organizationId: f.acme, taskId: urgent })).toBeUndefined();
  });
});

describe('the waker', () => {
  it('tells the first waiter that fits to try again, skips ones that do not, and lets ended tasks go', async () => {
    const f = await fixture();
    const key = accountKey(MANAGED_COMPUTE, 'aws');
    const [ended, big, small, last] = [await f.task(f.acme), await f.task(f.other), await f.task(f.acme), await f.task(f.other)];
    for (const [taskId, organizationId, cpu] of [[ended, f.acme, 2], [big, f.other, 8], [small, f.acme, 2], [last, f.other, 2]] as const)
      await enqueue(f.store, { taskId, organizationId, account: key, cpu }, 1_000);
    await f.store.db.prepare('UPDATE tasks SET lastView=? WHERE id=?').run(JSON.stringify({ status: 'done' }), ended);
    for (const taskId of [big, small, last]) await f.store.db.prepare('UPDATE tasks SET lastView=? WHERE id=?').run(JSON.stringify({ status: 'waiting' }), taskId);
    const told: string[] = [];
    const deps = { store: f.store, account: async () => ({ provider: 'aws', managed: true, pool: { cpu: 4 } }),
      retry: async (taskId: string) => { told.push(taskId); return true; } };
    expect(await wakeComputeQueue({ ...deps, now: 2_000 })).toEqual([small]);
    expect((await waiters(f.store, 2_000)).map((value) => value.taskId)).not.toContain(ended);
    // Told once, not again within the gap.
    expect(await wakeComputeQueue({ ...deps, now: 3_000 })).toEqual([]);
  });

  it('asks the first in line every couple of minutes where nothing tells whether there is room', async () => {
    const f = await fixture();
    const key = accountKey(f.acme, 'hetzner');
    const [first, second] = [await f.task(f.acme), await f.task(f.acme)];
    for (const taskId of [first, second]) {
      await enqueue(f.store, { taskId, organizationId: f.acme, account: key }, 1_000);
      await f.store.db.prepare('UPDATE tasks SET lastView=? WHERE id=?').run(JSON.stringify({ status: 'waiting' }), taskId);
    }
    const deps = { store: f.store, account: async () => ({ provider: 'hetzner', managed: false }), retry: async () => true };
    expect(await wakeComputeQueue({ ...deps, now: 2_000 })).toEqual([first]);
    expect(await wakeComputeQueue({ ...deps, now: 3_000 })).toEqual([]);
    expect(await wakeComputeQueue({ ...deps, now: 2_000 + BLIND_SIGNAL_GAP_MS })).toEqual([first]);
  });
});

describe('a parked world that cannot wake where its disk is', () => {
  it('is hibernated from its park checkpoint after a while, so its task restores it where it can run, and its agent is told', async () => {
    const f = await fixture();
    const stuck = await f.world(f.acme, 'aws', 'parked', 100);
    const recent = await f.world(f.acme, 'aws', 'parked', 100);
    const moved = await f.world(f.acme, 'aws', 'parked', 100);
    for (const handle of [stuck, recent]) {
      await f.store.saveWorldCheckpoint({ id: `checkpoint-${handle.id}`, worldId: handle.id, generation: 1, projectId: f.projects[f.acme]!.id,
        runnerPoolId: 'local', environmentDigest: 'test', repos: [], createdAt: Date.now() } as any);
    }
    const now = Date.now();
    await f.store.kvSet(wakeFullKey(stuck.id), JSON.stringify({ since: now - WAKE_RELOCATE_AFTER_MS - 1, generation: 1 }));
    await f.store.kvSet(wakeFullKey(recent.id), JSON.stringify({ since: now - 60_000, generation: 1 }));
    // Recorded for a generation it no longer is.
    await f.store.kvSet(wakeFullKey(moved.id), JSON.stringify({ since: now - WAKE_RELOCATE_AFTER_MS - 1, generation: 7 }));
    const worlds = new WorldRegistry();
    const destroy = vi.fn(async () => {});
    worlds.register({ kind: 'aws', parkable: true, destroy, probe: async () => undefined } as any);
    const addNotice = vi.fn(async () => {});
    const lifecycle = new WorldLifecycleManager(f.store, worlds, { checkpoint: vi.fn(), addNotice } as any);
    expect(await lifecycle.relocateStuckWakes(now)).toBe(1);
    expect(await f.store.worldState(stuck.id)).toBe('hibernated');
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(addNotice).toHaveBeenCalledWith(stuck.id, STUCK_WAKE_NOTICE);
    expect(await f.store.kvGet(wakeFullKey(stuck.id))).toBeUndefined();
    expect(await f.store.worldState(recent.id)).toBe('parked');
    expect(await f.store.kvGet(wakeFullKey(moved.id))).toBeUndefined();
    expect((await f.store.eventsSince(stuck.id, 0)).find((event) => event.type === 'world.hibernated')?.payload).toMatchObject({ reason: 'no-room' });
  });
});
