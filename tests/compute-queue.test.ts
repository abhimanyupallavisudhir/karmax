// The compute queue, the account budget's disk and parked machines, the waker
// and stuck wakes (wiki features/managed-compute § Queue, § Budget;
// features/compute-routing § Stuck wakes).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';
import { CHEAP_MOVE_BYTES, STUCK_WAKE_NOTICE, WorldLifecycleManager } from '../src/world/runners.js';
import { accountKey, dequeue, enqueue, ordered, RESERVE_AFTER_MS, WAITER_STALE_MS, WAKE_RELOCATE_AFTER_MS, waiters, wakeFullKey, withStandings, type Waiter } from '../src/world/compute-queue.js';
import { orderKey, runNowKey, treeKey } from '../src/scheduling/state.js';
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

  // pramana (2026-11-02): one task pinned to tavya's Hetzner asked for a 250 GB disk while 150 of its 324 GB were
  // taken; having waited, it kept its place for seven hours and every task behind it waited too.
  it('keeps no room for one ahead that needs more disk than is free: disks free only when worlds go, not by waiting', async () => {
    const f = await fixture();
    await f.world(f.other, 'hetzner', 'parked', 150);
    const big = await f.task(f.other);
    const small = await f.task(f.acme);
    const account = { provider: 'hetzner', managed: true, pool: { cpu: 10, diskGb: 324 } };
    const later = 10_000 + RESERVE_AFTER_MS + 120_000;
    // It keeps asking, as a waiting task does, and has waited long enough to keep its place.
    for (const at of [10_000, later - 60_000]) expect(await accountRoom(f.store, account, { organizationId: f.other, taskId: big, cpu: 8, diskGb: 250 }, at)).toBeDefined();
    expect(await accountRoom(f.store, account, { organizationId: f.acme, taskId: small, cpu: 2, diskGb: 20 }, later)).toBeUndefined();
    // With the disk free, it would keep its place.
    expect(await accountRoom(f.store, { ...account, pool: { cpu: 10, diskGb: 1000 } }, { organizationId: f.acme, taskId: small, cpu: 2, diskGb: 20 }, later))
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

describe('one organization\'s order: the quota scheduler\'s, with a tree\'s rank shared among the machines it holds', () => {
  const key = accountKey(MANAGED_COMPUTE, 'aws');
  async function org() {
    const f = await fixture();
    const sub = async (parent: string) => (await f.store.createTask({ projectId: f.projects[f.acme]!.id, title: 'S', parentTaskId: parent,
      workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'x' } as any })).id;
    /** `taskId` holds a machine now. */
    let leases = 0;
    const holds = async (taskId: string) => f.store.db.prepare(`INSERT INTO world_leases (id, runnerPoolId, organizationId, projectId, taskId, worldId,
      cpu, memoryMb, gpu, priority, state, createdAt) VALUES (?, ?, ?, ?, ?, ?, 2, 2048, 0, 0, 'active', 1)`)
      .run(`l${leases++}`, `${f.acme}:tavya-aws`, f.acme, f.projects[f.acme]!.id, taskId, taskId);
    const line = async (now = 10_000) => ordered(await withStandings(f.store, await waiters(f.store, now), now), key).map((w) => w.taskId);
    const wait = (taskId: string, at: number, organizationId = f.acme) => enqueue(f.store, { taskId, organizationId, account: key }, at);
    return { ...f, sub, holds, line, wait };
  }

  it('gives a task that fans out into many sub-tasks its share of machines, not all of them', async () => {
    const f = await org();
    const big = await f.task(f.acme), fresh = await f.task(f.acme);
    const parts = [await f.sub(big), await f.sub(big), await f.sub(big), await f.sub(big)];
    for (const part of parts.slice(0, 3)) await f.holds(part);
    // The big task's fourth sub-task waited first; a new task of the same priority still goes ahead of it.
    await f.wait(parts[3]!, 1_000);
    await f.wait(fresh, 2_000);
    expect(await f.line()).toEqual([fresh, parts[3]]);
    // Holding nothing, the big task's sub-task keeps its place.
    await f.store.db.prepare(`UPDATE world_leases SET state='released'`).run();
    expect(await f.line()).toEqual([parts[3], fresh]);
  });

  it('serves a task that has spent little before one that has spent a lot, and a higher priority first', async () => {
    const f = await org();
    const spender = await f.task(f.acme), fresh = await f.task(f.acme), urgent = await f.task(f.acme, 4);
    await f.store.kvSet(treeKey(spender), JSON.stringify({ organizationId: f.acme, spent: 400 }));
    await f.store.kvSet(treeKey(urgent), JSON.stringify({ organizationId: f.acme, spent: 5 }));
    await f.wait(spender, 1_000); await f.wait(fresh, 2_000); await f.wait(urgent, 3_000);
    expect(await f.line()).toEqual([urgent, fresh, spender]);
  });

  it('follows people\'s placements and Run now, and never reorders another organization\'s places', async () => {
    const f = await org();
    const a = await f.task(f.acme), b = await f.task(f.acme), c = await f.task(f.acme), theirs = await f.task(f.other);
    await f.wait(a, 1_000); await f.wait(theirs, 1_500, f.other); await f.wait(b, 2_000); await f.wait(c, 3_000);
    expect(await f.line()).toEqual([a, theirs, b, c]);
    // Someone placed c above a; then said to run b now.
    await f.store.kvSet(orderKey(f.acme), JSON.stringify([{ above: c, below: a, at: 1, moved: 'above' }]));
    expect(await f.line()).toEqual([c, theirs, a, b]);
    await f.store.kvSet(runNowKey(f.acme), JSON.stringify([{ root: b, at: 2 }]));
    expect(await f.line()).toEqual([b, theirs, c, a]);
  });

  it('admits by that order: a new task of the organization gets the next machine before the big task\'s next sub-task', async () => {
    const f = await org();
    const big = await f.task(f.acme), fresh = await f.task(f.acme);
    const parts = [await f.sub(big), await f.sub(big), await f.sub(big)];
    for (const part of parts.slice(0, 2)) await f.holds(part);
    await f.wait(fresh, 1_000);
    const account = { provider: 'aws', managed: true, pool: { cpu: 96 } };
    expect(await accountRoom(f.store, account, { organizationId: f.acme, taskId: parts[2], cpu: 2 }, 2_000))
      .toMatchObject({ reason: '1 waiting ahead' });
    expect(await accountRoom(f.store, account, { organizationId: f.acme, taskId: fresh, cpu: 2 }, 2_000)).toBeUndefined();
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

  // pramana#137: a move is worth waiting 15 minutes for only when it would
  // lose much. One that fetches or rebuilds little goes as soon as another
  // account has room, and its task tries again at once either way.
  describe('moves at once when it would lose little and another account has room', () => {
    async function stuckWorld(f: Awaited<ReturnType<typeof fixture>>, manifest: Record<string, unknown>) {
      const handle = await f.world(f.acme, 'hetzner', 'parked', 70);
      await f.store.saveWorldCheckpoint({ id: `checkpoint-${handle.id}`, worldId: handle.id, generation: 1, projectId: f.projects[f.acme]!.id,
        runnerPoolId: 'local', environmentDigest: 'test', repos: [], createdAt: Date.now(), ...manifest } as any);
      return handle;
    }
    async function sweep(f: Awaited<ReturnType<typeof fixture>>, roomElsewhere: boolean, since: number, now: number, ...handles: WorldHandle[]) {
      for (const handle of handles) await f.store.kvSet(wakeFullKey(handle.id), JSON.stringify({ since, generation: 1 }));
      const worlds = new WorldRegistry();
      worlds.register({ kind: 'hetzner', parkable: true, destroy: vi.fn(async () => {}), probe: async () => undefined } as any);
      const lifecycle = new WorldLifecycleManager(f.store, worlds,
        { checkpoint: vi.fn(), addNotice: vi.fn(async () => {}), roomElsewhere: vi.fn(async () => roomElsewhere) } as any);
      const retry = vi.fn(async () => true);
      lifecycle.retry = retry;
      return { moved: await lifecycle.relocateStuckWakes(now), retry };
    }
    const small = { ignored: { entries: [{ path: 'node_modules', bytes: 300 * 1024 ** 2, likelySecret: false }], truncated: false } };

    it('a minute after the refusal, and tells its task to try again now', async () => {
      const f = await fixture();
      const cheap = await stuckWorld(f, small);
      const nothingIgnored = await stuckWorld(f, {});
      const now = Date.now();
      const { moved, retry } = await sweep(f, true, now - 60_000, now, cheap, nothingIgnored);
      expect(moved).toBe(2);
      for (const handle of [cheap, nothingIgnored]) {
        expect(await f.store.worldState(handle.id)).toBe('hibernated');
        expect(retry).toHaveBeenCalledWith(handle.id);
        expect((await f.store.eventsSince(handle.id, 0)).find((event) => event.type === 'world.hibernated')?.payload)
          .toMatchObject({ reason: 'no-room-cheap-move' });
      }
    });

    it('not when it would lose much, may lose what it does not know, or nothing else has room', async () => {
      const f = await fixture();
      const bigIgnored = await stuckWorld(f, { ignored: { entries: [{ path: 'build', bytes: CHEAP_MOVE_BYTES + 1, likelySecret: false }], truncated: false } });
      const truncated = await stuckWorld(f, { ignored: { entries: [], truncated: true } });
      const unknown = await stuckWorld(f, { ignoredUnknown: true });
      // pramana's project data: 23 GB to restore on a new machine.
      const attachment = await f.store.createResourceAttachment({ organizationId: f.acme, projectId: f.projects[f.acme]!.id,
        name: 'Corpus', driver: 'object-tree@1', target: { kind: 'path', path: 'data' }, access: 'write', isolation: 'fork',
        source: {}, credentialHandles: [], publish: 'review' });
      const revision = await f.store.saveResourceRevision({ attachmentId: attachment.id, engine: 'restic', sealedRef: 'sealed',
        rootDigest: 'digest', bytes: 23 * 1024 ** 3 });
      const bigData = await stuckWorld(f, { resources: [{ attachmentId: attachment.id, revisionId: revision.id }] });
      const handles = [bigIgnored, truncated, unknown, bigData];
      const now = Date.now();
      expect((await sweep(f, true, now - 60_000, now, ...handles)).moved).toBe(0);
      for (const handle of handles) expect(await f.store.worldState(handle.id)).toBe('parked');

      const g = await fixture();
      const cheapButNowhere = await stuckWorld(g, small);
      expect((await sweep(g, false, now - 60_000, now, cheapButNowhere)).moved).toBe(0);
      expect(await g.store.worldState(cheapButNowhere.id)).toBe('parked');
      // After 15 minutes it moves anyway, as before, and its task tries again at once.
      const late = await sweep(g, false, now - WAKE_RELOCATE_AFTER_MS - 1, now, cheapButNowhere);
      expect(late.moved).toBe(1);
      expect(late.retry).toHaveBeenCalledWith(cheapButNowhere.id);
    });
  });
});
