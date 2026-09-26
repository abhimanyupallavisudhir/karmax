import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';
import { WorldLifecycleManager } from '../src/world/runners.js';
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
  const checkpointWorld = vi.fn(async () => checkpoint);
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
