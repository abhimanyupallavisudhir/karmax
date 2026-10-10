import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';
import { WorldLifecycleManager } from '../src/world/runners.js';
import { markCheckpointStale } from '../src/world/checkpoint-staleness.js';
import type { WorldHandle } from '../src/world/types.js';

const stores: Store[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const store of stores.splice(0)) await store.close(); });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
async function fixture() {
  const store = await Store.create(':memory:'); stores.push(store);
  const project = await store.createProject('Hibernate safely', { hibernateAfterMs: 0 });
  const task = await store.createTask({ projectId: project.id, title: 'Parked task', workflow: 'software-dev',
    workflowVersion: '1.0.0', params: { prompt: 'fixture' } });
  const handle = await store.registerWorld({ kind: 'memory', id: task.id, root: '/fixture',
    branch: 'main', base: 'main' }, project.id) as WorldHandle;
  await store.setWorldState(handle, 'parked');
  const checkpoint = { id: 'checkpoint-1', worldId: handle.id, generation: 1, projectId: project.id,
    runnerPoolId: 'local', environmentDigest: 'test', repos: [], createdAt: Date.now() };
  await store.saveWorldCheckpoint(checkpoint);
  const worlds = new WorldRegistry();
  const destroy = vi.fn(async () => {});
  const open = vi.fn(async () => ({ handle, destroy }));
  const probe = vi.fn(async (): Promise<string | undefined> => undefined);
  worlds.register({ kind: 'memory', open, probe } as any);
  const checkpointWorld = vi.fn(async (_handle: WorldHandle) => checkpoint);
  const lifecycle = new WorldLifecycleManager(store, worlds, { checkpoint: checkpointWorld } as any);
  return { store, project, handle, worlds, destroy, open, probe, checkpointWorld, lifecycle };
}

it('leaves an accessed parked world intact', async () => {
  const f = await fixture();
  const release = await f.worlds.holdAccess(f.handle.id);
  try { expect(await f.lifecycle.sweep(Date.now() + 1)).toBe(0); }
  finally { release(); }
  expect(f.destroy).not.toHaveBeenCalled();
  expect(await f.store.worldState(f.handle.id)).toBe('parked');
});

it('rechecks access acquired while fetching the checkpoint', async () => {
  const f = await fixture(), entered = deferred(), finish = deferred();
  const lookup = f.store.latestWorldCheckpoint.bind(f.store);
  vi.spyOn(f.store, 'latestWorldCheckpoint').mockImplementation(async id => {
    entered.resolve(); await finish.promise; return lookup(id);
  });
  const sweep = f.lifecycle.sweep(Date.now() + 1);
  await entered.promise;
  const release = await f.worlds.holdAccess(f.handle.id);
  try { finish.resolve(); expect(await sweep).toBe(0); }
  finally { release(); }
  expect(f.destroy).not.toHaveBeenCalled();
});

it('does not destroy a generation restored while opening a parked candidate', async () => {
  const f = await fixture();
  f.open.mockImplementation(async () => {
    const handle = await f.store.registerWorld({ ...f.handle, generation: 2 }, f.project.id) as WorldHandle;
    return { handle, destroy: f.destroy };
  });
  expect(await f.lifecycle.sweep(Date.now() + 1)).toBe(0);
  expect(f.destroy).not.toHaveBeenCalled();
  expect(await f.store.worldState(f.handle.id)).toBe('ready');
});

it('rejects a selection whose world was touched before transition ownership', async () => {
  const f = await fixture();
  const list = f.store.listWorldInstances.bind(f.store);
  vi.spyOn(f.store, 'listWorldInstances').mockImplementation(async (state, before) => {
    const candidates = await list(state, before);
    if (state === 'parked') {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 100);
      try { await f.store.setWorldState(f.handle, 'parked'); }
      finally { clock.mockRestore(); }
    }
    return candidates;
  });
  expect(await f.lifecycle.sweep(Date.now() + 1)).toBe(0);
  expect(f.destroy).not.toHaveBeenCalled();
});

it.each(['missing', 'ready', undefined])('only treats confirmed provider loss as eviction: %s', async state => {
  const f = await fixture();
  f.open.mockRejectedValue(new Error('provider temporarily unavailable'));
  f.probe.mockResolvedValue(state);
  expect(await f.lifecycle.sweep(Date.now() + 1)).toBe(state === 'missing' ? 1 : 0);
  expect(await f.store.worldState(f.handle.id)).toBe(state === 'missing' ? 'hibernated' : 'parked');
  expect((await f.store.eventsOfType(f.handle.id, state === 'missing' ? 'world.hibernated' : 'world.hibernate_failed')))
    .toHaveLength(1);
});

it('requires a checkpoint for the generation being destroyed', async () => {
  const f = await fixture();
  const newer = await f.store.registerWorld({ ...f.handle, generation: 2 }, f.project.id) as WorldHandle;
  await f.store.setWorldState(newer, 'parked');
  f.open.mockResolvedValue({ handle: newer, destroy: f.destroy });
  f.checkpointWorld.mockResolvedValue({ id: 'checkpoint-2', worldId: newer.id, generation: 2,
    projectId: f.project.id, runnerPoolId: 'local', environmentDigest: 'test', repos: [], createdAt: Date.now() });
  expect(await f.lifecycle.sweep(Date.now() + 1)).toBe(1);
  expect(f.checkpointWorld).toHaveBeenCalledWith(expect.objectContaining({ generation: 2 }));
  expect(f.destroy).toHaveBeenCalledOnce();
});

it.each(['replacement', 'released', 'touched'])('ignores a missing probe after the selected world is %s', async change => {
  const f = await fixture();
  await f.store.setWorldState(f.handle, 'ready');
  f.probe.mockImplementation(async () => {
    if (change === 'replacement') await f.store.registerWorld({ ...f.handle, generation: 2 }, f.project.id);
    else if (change === 'released') await f.store.setWorldState(f.handle, 'released');
    else {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 100);
      try { await f.store.setWorldState(f.handle, 'ready'); } finally { clock.mockRestore(); }
    }
    return 'missing';
  });
  await f.lifecycle.sweep(Date.now() + 20 * 60_000);
  expect(f.probe).toHaveBeenCalledOnce();
  expect(await f.store.worldState(f.handle.id)).toBe(change === 'released' ? 'released' : 'ready');
  expect(await f.store.eventsOfType(f.handle.id, 'world.providerLost')).toHaveLength(0);
});

it('records a missing probe for an unchanged ready world', async () => {
  const f = await fixture();
  await f.store.setWorldState(f.handle, 'ready');
  f.probe.mockResolvedValue('missing');
  await f.lifecycle.sweep(Date.now() + 20 * 60_000);
  expect(await f.store.worldState(f.handle.id)).toBe('degraded');
  expect(await f.store.eventsOfType(f.handle.id, 'world.providerLost')).toHaveLength(1);
});

it('does not reap an undecidable provider reference (WD-1)', async () => {
  const f = await fixture();
  await f.store.setWorldState(f.handle, 'ready');
  const destroy = vi.fn(async () => {});
  f.worlds.register({ kind: 'memory', open: f.open, listSandboxes: async () => [{
    sandboxId: 'unreadable', taskId: f.handle.id, matches: () => undefined, destroy,
  }] } as any);
  await f.lifecycle.sweep();
  expect(destroy).not.toHaveBeenCalled();
});

it('continues after one checkpoint fails (WD-2)', async () => {
  const f = await fixture();
  const task = await f.store.createTask({ projectId: f.project.id, title: 'Second parked task',
    workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'fixture' } });
  const second = await f.store.registerWorld({ ...f.handle, id: task.id }, f.project.id);
  await f.store.setWorldState(second, 'parked');
  vi.spyOn(f.store, 'latestWorldCheckpoint').mockResolvedValue(undefined);
  f.checkpointWorld.mockImplementation(async handle => {
    if (handle.id === f.handle.id) throw new Error('checkpoint unavailable');
    return { id: 'second-checkpoint', worldId: task.id, generation: 1, projectId: f.project.id,
      runnerPoolId: 'local', environmentDigest: 'test', repos: [], createdAt: Date.now() };
  });
  expect(await f.lifecycle.sweep(Date.now() + 100)).toBe(1);
  expect(await f.store.worldState(f.handle.id)).toBe('parked');
  expect(await f.store.worldState(second.id)).toBe('hibernated');
});

it('never invokes recovery to destroy an old sandbox (WD-7)', async () => {
  const f = await fixture();
  f.open.mockRejectedValue(new Error('sandbox vanished'));
  const recover = vi.fn(async () => undefined);
  f.worlds.setRecoveryHandler(recover);
  await f.lifecycle.sweep(Date.now() + 1);
  expect(recover).not.toHaveBeenCalled();
});

it('retries explicitly pending teardown for terminal tasks (WD-14)', async () => {
  const f = await fixture();
  await f.store.saveView(f.handle.id, { taskId: f.handle.id, title: 'Done', workflow: 'software-dev',
    stage: 'done', status: 'done', messages: [], actions: [], state: {}, updatedAt: Date.now() } as any);
  const pending = await f.store.updateWorldMeta(f.handle, { teardownPending: true });
  await f.store.setWorldState(pending, 'degraded');
  await f.lifecycle.sweep();
  expect(f.destroy).toHaveBeenCalledOnce();
  expect(await f.store.worldState(f.handle.id)).toBe('released');
});

it('backs off a parked world whose checkpoint keeps failing (WD-2)', async () => {
  const f = await fixture();
  vi.spyOn(f.store, 'latestWorldCheckpoint').mockResolvedValue(undefined);
  f.checkpointWorld.mockRejectedValue(new Error('checkpoint file limit exceeded'));
  const start = Date.now() + 1;
  const minute = 60_000;
  // Every attempt opens (and so resumes and bills) the provider sandbox. A
  // 60 s sweep must not repeat it every tick: attempts are spaced 5, 10, 20 min.
  for (let at = start; at <= start + 40 * minute; at += minute) await f.lifecycle.sweep(at);
  expect(f.checkpointWorld).toHaveBeenCalledTimes(4);
  const failures = await f.store.eventsOfType(f.handle.id, 'world.hibernate_failed');
  expect(failures).toHaveLength(4);
  expect((failures.at(-1) as any).payload).toMatchObject({ attempts: 4, retryAt: start + 75 * minute });

  // Using the world is new evidence: the next idle period starts afresh.
  await f.store.setWorldState(f.handle, 'parked');
  f.checkpointWorld.mockClear();
  f.checkpointWorld.mockResolvedValue({ id: 'checkpoint-2', worldId: f.handle.id, generation: 1,
    projectId: f.project.id, runnerPoolId: 'local', environmentDigest: 'test', repos: [], createdAt: Date.now() });
  expect(await f.lifecycle.sweep(Date.now() + 1)).toBe(1);
  expect(f.checkpointWorld).toHaveBeenCalledOnce();
});

it('backs off provider teardown failures the same way (WD-2)', async () => {
  const f = await fixture();
  f.destroy.mockRejectedValue(new Error('provider timeout'));
  const start = Date.now() + 1;
  await f.lifecycle.sweep(start);
  await f.lifecycle.sweep(start + 60_000);
  expect(f.destroy).toHaveBeenCalledOnce();
  await f.lifecycle.sweep(start + 5 * 60_000);
  expect(f.destroy).toHaveBeenCalledTimes(2);
});

// Audit R-6: a park checkpoint that hit a size cap only logged a warning, and
// hibernation then destroyed the sandbox against the older checkpoint, losing
// whatever changed since. A recorded failure makes hibernation re-checkpoint first.
it('re-checkpoints a world whose last park checkpoint failed before destroying it', async () => {
  const f = await fixture();
  await markCheckpointStale(f.store, f.handle, 'checkpoint total size limit exceeded');
  expect(await f.lifecycle.sweep(Date.now() + 1)).toBe(1);
  expect(f.checkpointWorld).toHaveBeenCalledTimes(1);
  expect(f.destroy).toHaveBeenCalledTimes(1);
});

it('keeps a world whose newest state cannot be checkpointed', async () => {
  const f = await fixture();
  await markCheckpointStale(f.store, f.handle, 'checkpoint total size limit exceeded');
  f.checkpointWorld.mockRejectedValue(new Error('checkpoint total size limit exceeded'));
  expect(await f.lifecycle.sweep(Date.now() + 1)).toBe(0);
  expect(f.destroy).not.toHaveBeenCalled();
  expect(await f.store.worldState(f.handle.id)).toBe('parked');
});

it('trusts the latest checkpoint when no failure was recorded for this generation', async () => {
  const f = await fixture();
  await markCheckpointStale(f.store, { ...f.handle, generation: 7 }, 'an earlier generation');
  expect(await f.lifecycle.sweep(Date.now() + 1)).toBe(1);
  expect(f.checkpointWorld).not.toHaveBeenCalled();
  expect(f.destroy).toHaveBeenCalledTimes(1);
});

// pramana#3 (2026-10-09): a finished task's world (#552) was held by a stuck
// operation in the worker. Every sweep reached that task's sandbox in the
// orphan reaper, waited 30 s for its operation lock, threw "file lock admission
// timed out", and stopped there, silently: no parked world was hibernated or
// resized for anyone, and a 50 GB resize waited for hours.
it('hibernates parked worlds although another world is busy in every earlier step', async () => {
  const f = await fixture();
  const busy = 'task_busy';
  const operate = f.worlds.withOperation.bind(f.worlds);
  vi.spyOn(f.worlds, 'withOperation').mockImplementation(((id: string, work: () => Promise<unknown>) =>
    id === busy ? Promise.reject(new Error('file lock admission timed out')) : operate(id, work)) as any);
  f.worlds.register({ kind: 'memory', open: f.open, probe: f.probe, listSandboxes: async () => [{
    sandboxId: 'held', taskId: busy, matches: () => false, destroy: vi.fn(async () => {}),
  }] } as any);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(await f.lifecycle.sweep(Date.now() + 1)).toBe(1);
  expect(await f.store.worldState(f.handle.id)).toBe('hibernated');
  // Said, not swallowed — once while it keeps failing the same way.
  await f.store.setWorldState(f.handle, 'parked');
  await f.lifecycle.sweep(Date.now() + 2);
  expect(warn.mock.calls.filter(([text]) => String(text).includes('file lock admission timed out'))).toHaveLength(1);
});

// Task #552 (2026-10-09): released when it finished, then revived by another
// task's open and left degraded, holding a runner lease. Nothing tore it down
// again: only worlds marked teardownPending were retried.
it('tears down a degraded world whose task has finished, marked or not', async () => {
  const f = await fixture();
  await f.store.saveView(f.handle.id, { taskId: f.handle.id, title: 'Done', workflow: 'software-dev',
    stage: 'done', status: 'done', messages: [], actions: [], state: {}, updatedAt: Date.now() } as any);
  await f.store.setWorldState(f.handle, 'degraded');
  await f.lifecycle.sweep();
  expect(await f.store.worldState(f.handle.id)).toBe('released');
  // A running task's degraded world is left to its own recovery.
  const f2 = await fixture();
  await f2.store.setWorldState(f2.handle, 'degraded');
  await f2.lifecycle.sweep();
  expect(await f2.store.worldState(f2.handle.id)).toBe('degraded');
});
