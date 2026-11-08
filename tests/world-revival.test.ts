import { afterEach, expect, it, vi } from 'vitest';
import { Context } from '@temporalio/activity';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { LocalObjectStore } from '../src/store/objects.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { WorldRegistry } from '../src/world/registry.js';
import { WorktreeProvider } from '../src/world/worktree.js';
import { WorldCheckpointService } from '../src/world/checkpoint.js';
import { git, gitOrThrow, ensureIdentity } from '../src/world/git.js';
import { makeCoreActivities } from '../src/activities/core.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import type { WorldHandle } from '../src/world/types.js';
import { ManagedComputeBusy } from '../src/world/managed-compute.js';
import { accountKey, enqueue, waiters } from '../src/world/compute-queue.js';

// Task #552 (2026-10-09): resized at 00:13, its world was restored as
// generation 2 from a generation-1 checkpoint; the task finished at 00:36 and
// its world was released. Task #557, which forked #552's agent, then opened
// #552's world to copy the agent's session out of it. Opening re-leased the
// released world and marked it ready, recovery found the sandbox missing and
// restored the generation-1 checkpoint as "generation 2", which the store
// refuses (generations only increase): a sandbox made and thrown away, about
// 230 runner leases an hour, for eleven hours.

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-revival-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  await gitOrThrow(repo, ['init', '-q', '-b', 'main']);
  await ensureIdentity(repo);
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'before\n');
  await git(repo, ['add', '-A']);
  await gitOrThrow(repo, ['commit', '-q', '-m', 'init']);
  const store = await Store.create(':memory:');
  cleanups.push(() => store.close());
  const project = await store.createProject('Revival', { repos: [repo], defaultBase: 'main', worldProvider: 'sandbox-test' });
  const task = await store.createTask({ projectId: project.id, title: 'Task', workflow: 'software-dev',
    workflowVersion: '1.0.0', params: { prompt: 'test' } });
  // A remote provider over worktrees whose sandboxes below `alive` are gone.
  const worlds = new WorldRegistry();
  const worktrees = new WorktreeProvider(path.join(dir, 'worlds'));
  let alive = 1;
  const gone = (handle: { generation?: number }) => (handle.generation ?? 1) < alive;
  // Like E2B, a sandbox records the generation it was made for.
  const create = vi.fn(async (spec: any) => { const w = await worktrees.create(spec); w.handle.kind = 'sandbox-test' as any;
    if (spec.generation) w.handle.generation = spec.generation; return w; });
  worlds.register({
    kind: 'sandbox-test', parkable: true,
    capabilities: { remote: true, pty: false, snapshots: true, ports: false, networkPolicy: false },
    create,
    async open(handle: WorldHandle) {
      if (gone(handle)) throw new Error('sandbox vanished: 404 not found');
      const w = await worktrees.open(handle); w.handle.kind = 'sandbox-test' as any; return w;
    },
    async probe(handle: WorldHandle) { return gone(handle) ? 'missing' as const : 'ready' as const; },
  } as any);
  const checkpoints = new WorldCheckpointService(store, worlds, new LocalObjectStore(path.join(dir, 'objects')),
    new CredentialBroker(new Vault(path.join(dir, 'vault'))));
  const leases: string[] = [];
  const runners = {
    acquire: vi.fn(async (input: any) => {
      const lease = await store.requestWorldLease({ runnerPoolId: 'pool', organizationId: project.organizationId!,
        projectId: project.id, taskId: input.taskId, worldId: input.worldId });
      leases.push(lease.id);
      return { leaseId: lease.id, runnerPoolId: 'pool' };
    }),
    release: vi.fn(async (id: string) => { await store.releaseWorldLease(id); }),
  };
  await store.createRunnerPool({ id: 'pool', organizationId: project.organizationId!, name: 'Pool', provider: 'sandbox-test',
    mode: 'customer', capacity: { activeWorlds: 10, cpu: 20, memoryMb: 20480, gpu: 0 }, enabled: true });
  const world = await worlds.create('sandbox-test', { taskId: task.id, repos: [repo], base: 'main' });
  world.handle.meta = { projectId: project.id };
  world.handle = await store.registerWorld(world.handle, project.id) as WorldHandle;
  await world.writeFile('tracked.txt', 'edited in the sandbox\n');
  await checkpoints.checkpoint(world.handle);
  vi.spyOn(Context, 'current').mockReturnValue({ heartbeat() {}, cancellationSignal: new AbortController().signal,
    info: { attempt: 1, workflowExecution: { runId: 'run', workflowId: 'other' }, activityId: 'a', currentAttemptScheduledTimestampMs: Date.now() } } as any);
  const core = makeCoreActivities({ store, worlds, adapters: new Map(), profiles: new ProfileResolver(store, 'mock'),
    checkpoints, runners: runners as any });
  const finish = (status: string) => store.saveView(task.id, { taskId: task.id, title: 'Task', workflow: 'software-dev',
    stage: status, status, messages: [], actions: [], state: {}, updatedAt: Date.now() } as any);
  return { store, project, task, worlds, world, create, checkpoints, core, runners, leases, finish,
    vanish: async (generation: number) => { alive = generation + 1; } };
}

it('restores an older generation\'s checkpoint as a newer generation than the current one', async () => {
  const f = await fixture();
  // Generation 2 was made (a resize restored the checkpoint) and never checkpointed itself.
  const second = await f.store.registerWorld({ ...(await f.store.currentWorld(f.task.id))!, generation: 2 }, f.project.id);
  await f.world.destroy();
  await f.vanish(2);
  expect((await f.core.commitWork(second as WorldHandle, 'after recovery')).committed).toBe(true);
  expect((await f.store.currentWorld(f.task.id))?.generation).toBe(3);
});

it('never reopens a finished task\'s released world for another task', async () => {
  const f = await fixture();
  await f.world.destroy();
  await f.finish('done');
  await f.store.setWorldState((await f.store.currentWorld(f.task.id))!, 'released');
  await f.vanish(1);
  f.create.mockClear();
  // A fork reading the agent's session out of this world, say.
  await expect(f.core.commitWork((await f.store.currentWorld(f.task.id)) as WorldHandle, 'from a fork')).rejects.toThrow(/released/);
  expect(await f.store.worldState(f.task.id)).toBe('released');
  expect(f.runners.acquire).not.toHaveBeenCalled();
  expect(f.create).not.toHaveBeenCalled();
});

it('does not rebuild a finished task\'s world whose sandbox vanished', async () => {
  const f = await fixture();
  await f.world.destroy();
  await f.finish('done');
  await f.vanish(1);
  f.create.mockClear();
  await expect(f.core.commitWork((await f.store.currentWorld(f.task.id)) as WorldHandle, 'late')).rejects.toThrow(/vanished/);
  expect(f.create).not.toHaveBeenCalled();
  expect((await f.store.currentWorld(f.task.id))?.generation).toBe(1);
});

// pramana#137 (2026-11-02): a parked world that could not wake for want of room
// on its account was hibernated so that its task could restore it where there
// is room, but every later turn asked that same account for room first, and
// waited behind it for hours instead of moving.
it('restores a hibernated world where its task can run before asking its old account for room', async () => {
  const f = await fixture();
  await f.world.destroy();
  await f.vanish(1);
  await f.store.setWorldState((await f.store.currentWorld(f.task.id))!, 'hibernated');
  // The old account has no room; only a restored world can be let in.
  let restored = false;
  f.create.mockImplementation(async (spec: any) => { restored = true; const w = await new WorktreeProvider(path.dirname(f.world.handle.root)).create(spec);
    w.handle.kind = 'sandbox-test' as any; if (spec.generation) w.handle.generation = spec.generation; return w; });
  const acquire = f.runners.acquire.getMockImplementation()!;
  f.runners.acquire.mockImplementation(async (input: any) => {
    if (!restored) throw new ManagedComputeBusy('4 tasks are waiting ahead of this one for tavya\'s Hetzner Cloud computers; waiting its turn.');
    return acquire(input);
  });
  expect((await f.core.commitWork((await f.store.currentWorld(f.task.id)) as WorldHandle, 'after the move')).committed).toBe(true);
  expect((await f.store.currentWorld(f.task.id))?.generation).toBe(2);
  expect(await f.store.worldState(f.task.id)).toBe('ready');
});

// pramana#149 (2026-11-02): it had its machine at 10:18 but kept first place in
// the queue while it restored 22 GB of project data, so every task behind it
// went on waiting for room it no longer needed.
it('leaves the compute queue as soon as its machine is granted, not once its world has opened', async () => {
  const f = await fixture();
  await enqueue(f.store, { taskId: f.task.id, organizationId: f.project.organizationId!, account: accountKey('installation', 'sandbox-test') });
  let queuedWhileOpening: string[] | undefined;
  const acquire = f.runners.acquire.getMockImplementation()!;
  f.runners.acquire.mockImplementation(async (input: any) => acquire(input));
  const open = vi.spyOn(f.worlds, 'open');
  open.mockImplementation(async function (this: any, handle: any) {
    queuedWhileOpening = (await waiters(f.store)).map((w) => w.taskId);
    open.mockRestore();
    return f.worlds.open(handle);
  });
  await f.store.setWorldState((await f.store.currentWorld(f.task.id))!, 'parked');
  await f.core.commitWork((await f.store.currentWorld(f.task.id)) as WorldHandle, 'woken');
  expect(queuedWhileOpening).toEqual([]);
});

// 2026-11-04: Confirm woke a parked world inside a 5-minute activity while the
// pool was full; the lease wait outlived the activity and the landing timed
// out without saying why. A wake now waits at most half its activity's time,
// then gives up as a machine wait the workflow shows and retries.
it('waits for its machine only as long as its activity allows, then says it waits for a machine', async () => {
  const f = await fixture();
  const scheduled = Date.now();
  vi.spyOn(Context, 'current').mockReturnValue({ heartbeat() {}, cancellationSignal: new AbortController().signal,
    info: { attempt: 1, workflowExecution: { runId: 'run', workflowId: 'other' }, activityId: 'a',
      currentAttemptScheduledTimestampMs: scheduled, startToCloseTimeoutMs: 300_000 } } as any);
  const { MachineQueued } = await import('../src/world/machine-wait.js');
  f.runners.acquire.mockImplementation(async () => {
    throw new MachineQueued('All 5 computers this organization may run at once are in use (E2B · organization BYOK). 2 tasks are ahead of this one.');
  });
  await f.store.setWorldState((await f.store.currentWorld(f.task.id))!, 'parked');
  const failure: any = await f.core.commitWork((await f.store.currentWorld(f.task.id)) as WorldHandle, 'woken').then(() => undefined, (e) => e);
  expect(f.runners.acquire).toHaveBeenCalledWith(expect.objectContaining({ waitUntil: scheduled + 150_000 }));
  // The workflow waits for a machine on 'world-capacity'; the activity retries first, keeping its place.
  expect(failure).toMatchObject({ type: 'world-capacity', nonRetryable: false });
  expect(failure.message).toMatch(/2 tasks are ahead of this one/);
});

// Task #779 (2026-11-01 04:19:15): two activities opened its parked world at
// once. Each saw no active lease named in the world's handle, each asked for
// one, both were admitted in the same millisecond, and the second to publish
// overwrote the first's `worldLeaseId`. The lease it overwrote was named by
// nothing, kept the world from ever parking (its park check counts every other
// lease as a user) and held E2B capacity for 3.5 days until released by hand.
it('publishes one lease when two openers wake a parked world at once, and gives back the other', async () => {
  const f = await fixture();
  await f.store.setWorldState((await f.store.currentWorld(f.task.id))!, 'parked');
  await f.store.updateWorldMeta((await f.store.currentWorld(f.task.id))!, { worldLeaseId: null });
  // Both admissions are in flight before either publishes.
  const acquire = f.runners.acquire.getMockImplementation()!;
  let arrived = 0;
  let admitBoth!: () => void;
  const bothArrived = new Promise<void>((resolve) => { admitBoth = resolve; });
  f.runners.acquire.mockImplementation(async (input: any) => {
    if (++arrived === 2) admitBoth();
    await bothArrived;
    return acquire(input);
  });
  const handle = (await f.store.currentWorld(f.task.id)) as WorldHandle;
  await Promise.all([f.core.commitWork(handle, 'first opener'), f.core.commitWork(handle, 'second opener')]);

  expect(f.runners.acquire).toHaveBeenCalledTimes(2);
  const named = (await f.store.currentWorld(f.task.id))?.meta?.worldLeaseId;
  expect(f.leases).toContain(named);
  expect((await f.store.worldLease(String(named)))?.state).toBe('active');
  expect(await f.store.activeWorldLeaseCount(f.task.id)).toBe(1);
  const lost = f.leases.find((id) => id !== named)!;
  expect((await f.store.worldLease(lost))?.state).toBe('released');
  // Only the published lease is reported as the world's.
  const acquired = (await f.store.eventsSince(f.task.id, 0)).filter((event) => event.type === 'world.lease-acquired');
  expect(acquired.map((event) => (event.payload as { leaseId: string }).leaseId)).toEqual([named]);
});
