import { afterEach, expect, it, vi } from 'vitest';
import { Context } from '@temporalio/activity';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { makeCoreActivities } from '../src/activities/core.js';
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
  const project = await store.createProject('Teardown');
  const task = await store.createTask({ projectId: project.id, title: 'Finish', workflow: 'software-dev',
    workflowVersion: '1.0.0', params: { prompt: 'fixture', _workflowRunId: 'original' } });
  const handle = await store.registerWorld({ id: task.id, kind: 'memory', root: '/fixture', branch: 'task', base: 'main',
    meta: { worldLeaseId: 'lease-original' } }, project.id) as WorldHandle;
  const destroy = vi.fn(async () => {});
  const open = vi.fn(async (handle: WorldHandle) => ({ handle, destroy }));
  const create = vi.fn(async () => ({ handle, destroy }));
  const release = vi.fn(async () => {});
  const resources = { release: vi.fn(async () => {}) };
  const worlds = new WorldRegistry();
  worlds.register({ kind: 'memory', open, create } as any);
  const core = makeCoreActivities({ store, worlds, adapters: new Map(), profiles: new ProfileResolver(store, 'mock'),
    runners: { release } as any, resources: resources as any });
  vi.spyOn(Context, 'current').mockReturnValue({ info: { workflowExecution: { runId: 'original' } } } as any);
  return { store, project, task, handle, destroy, open, create, release, resources, worlds, core };
}

it('refuses cleanup from a replaced workflow run', async () => {
  const f = await fixture();
  await f.store.updateTaskParams(f.task.id, { ...f.task.params, _workflowRunId: 'replacement' });
  await f.core.destroyWorld(f.handle);
  expect(f.destroy).not.toHaveBeenCalled();
  expect(f.resources.release).not.toHaveBeenCalled();
  expect(f.release).not.toHaveBeenCalled();
  expect(await f.store.worldState(f.task.id)).toBe('ready');
});

it('cleans a legitimately restored generation belonging to the same workflow run', async () => {
  const f = await fixture();
  await f.store.registerWorld({ ...f.handle, generation: 2 }, f.project.id);
  await f.core.destroyWorld(f.handle);
  expect(f.open).toHaveBeenCalledWith(expect.objectContaining({ generation: 2 }));
  expect(f.destroy).toHaveBeenCalledOnce();
  expect(await f.store.worldState(f.task.id)).toBe('released');
});

it('does not follow a stale handle without proof that the replacement belongs to this run', async () => {
  const f = await fixture();
  vi.spyOn(Context, 'current').mockImplementation(() => { throw new Error('no activity context'); });
  await f.store.registerWorld({ ...f.handle, generation: 2 }, f.project.id);
  await f.core.destroyWorld(f.handle);
  expect(f.destroy).not.toHaveBeenCalled();
  expect(f.release).not.toHaveBeenCalled();
});

it('does not reopen a released world when retrying lease cleanup', async () => {
  const f = await fixture();
  await f.store.setWorldState(f.handle, 'released');
  await f.core.destroyWorld(f.handle);
  expect(f.open).not.toHaveBeenCalled();
  expect(f.destroy).not.toHaveBeenCalled();
  expect(f.release).toHaveBeenCalledWith('lease-original', 'memory');
  expect(await f.store.worldState(f.task.id)).toBe('released');
});

it('rechecks ownership after resource cleanup before touching the provider', async () => {
  const f = await fixture();
  f.resources.release.mockImplementation(async () => {
    await f.store.updateTaskParams(f.task.id, { ...f.task.params, _workflowRunId: 'replacement' });
  });
  await f.core.destroyWorld(f.handle);
  expect(f.destroy).not.toHaveBeenCalled();
  expect(f.release).not.toHaveBeenCalled();
});

it('serializes creation behind a provider teardown already in progress', async () => {
  const f = await fixture(), entered = deferred(), finish = deferred();
  f.destroy.mockImplementation(async () => { entered.resolve(); await finish.promise; });
  const destroying = f.core.destroyWorld(f.handle);
  await entered.promise;
  const creating = f.worlds.create('memory', { taskId: f.task.id, base: 'main' });
  await new Promise(resolve => setImmediate(resolve));
  expect(f.create).not.toHaveBeenCalled();
  finish.resolve(); await destroying; await creating;
  expect(f.create).toHaveBeenCalledOnce();
});

it('honors cancellation while creation waits for transition ownership', async () => {
  const f = await fixture(), entered = deferred(), finish = deferred();
  const holding = f.worlds.withOperation(f.task.id, async () => { entered.resolve(); await finish.promise; });
  await entered.promise;
  const cancellation = new AbortController();
  const creating = f.worlds.create('memory', { taskId: f.task.id, base: 'main', signal: cancellation.signal });
  const rejected = expect(creating).rejects.toThrow('cancelled');
  cancellation.abort(new Error('cancelled'));
  finish.resolve(); await holding; await rejected;
  expect(f.create).not.toHaveBeenCalled();
});
