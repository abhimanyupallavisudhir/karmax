import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';
import { WorldHandoffService } from '../src/world/handoff.js';
import type { TaskView } from '../src/domain/types.js';
import type { WorldHandle } from '../src/world/types.js';

import * as gitBroker from '../src/world/git-broker.js';

const stores: Store[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const store of stores.splice(0)) await store.close(); });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
async function fixture() {
  const store = await Store.create(':memory:'); stores.push(store);
  const project = await store.createProject('Handoff');
  const repository = await store.upsertRepository({ organizationId: project.organizationId!, provider: 'github',
    providerId: '7', owner: 'fixture', name: 'repo', sshUrl: 'git@github.com:fixture/repo.git', defaultBranch: 'main', private: true });
  await store.attachProjectRepository({ projectId: project.id, repositoryId: repository.id });
  const task = await store.createTask({ projectId: project.id, title: 'Review', workflow: 'software-dev',
    workflowVersion: '1.0.0', params: { prompt: 'fixture' } });
  const view = { taskId: task.id, title: task.title, workflow: task.workflow, stage: 'review', status: 'waiting',
    waitingFor: { kind: 'human' }, actions: [], messages: [], state: {}, updatedAt: 1 } as TaskView;
  await store.saveView(task.id, view);
  const handle = await store.registerWorld({ id: task.id, kind: 'e2b', root: '/fixture', branch: 'task', base: 'main' }, project.id) as WorldHandle;
  await store.createRunnerPool({ id: 'fixture', organizationId: project.organizationId!, name: 'Fixture',
    provider: 'e2b', mode: 'customer', capacity: { activeWorlds: 1, cpu: 2, memoryMb: 2048, gpu: 0 }, enabled: true });
  const runners = {
    acquire: vi.fn(async () => ({ leaseId: (await store.requestWorldLease({ runnerPoolId: 'fixture',
      organizationId: project.organizationId!, projectId: project.id, taskId: task.id, worldId: task.id })).id, runnerPoolId: 'fixture' })),
    release: vi.fn(async (id: string) => store.releaseWorldLease(id)),
  };
  const worlds = new WorldRegistry();
  let parked = false;
  const open = vi.fn(async () => ({ handle }));
  const park = vi.fn(async () => { parked = true; return handle; });
  const scrubSecrets = vi.fn(async () => {});
  worlds.register({ kind: 'e2b', capabilities: { remote: true }, open, park, status: async () => parked ? 'parked' : 'ready' } as any);
  const importBranch = vi.spyOn(gitBroker, 'brokerRefreshBranch').mockResolvedValue({ updated: [] });
  const handoff = new WorldHandoffService(store, worlds, {} as any, runners as any, undefined, undefined, { scrubSecrets } as any);
  return { store, task, view, handle, worlds, runners, open, park, scrubSecrets, handoff, importBranch };
}

it('imports, parks and releases its admission under one transition', async () => {
  const f = await fixture();
  expect(await f.handoff.refresh(f.task.id, f.view)).toEqual({ updated: [], parked: true });
  expect(f.importBranch).toHaveBeenCalledOnce();
  expect(f.park).toHaveBeenCalledOnce();
  expect(await f.store.activeWorldLeaseCount(f.task.id)).toBe(0);
  expect((await f.store.currentWorld(f.task.id))?.meta?.worldLeaseId).toBeNull();
});

it('does not hold transition ownership while waiting for capacity, and rechecks the review afterward', async () => {
  const f = await fixture(), entered = deferred(), capacity = deferred();
  const acquire = f.runners.acquire.getMockImplementation()!;
  f.runners.acquire.mockImplementation(async () => { entered.resolve(); await capacity.promise; return acquire(); });
  const pending = f.handoff.refresh(f.task.id, f.view);
  const rejected = expect(pending).rejects.toThrow('task or world changed');
  await entered.promise;
  await f.worlds.withOperation(f.task.id, () => f.store.saveView(f.task.id, { ...f.view, status: 'active' }));
  capacity.resolve(); await rejected;
  expect(f.runners.release).toHaveBeenCalledOnce();
  expect(await f.store.activeWorldLeaseCount(f.task.id)).toBe(0);
  expect(f.importBranch).not.toHaveBeenCalled();
});

it.each(['active', 'access'])('keeps the world and its credentials when %s changes during import', async change => {
  const f = await fixture(), entered = deferred(), finish = deferred();
  f.importBranch.mockImplementation(async () => { entered.resolve(); await finish.promise; return { updated: [] }; });
  const pending = f.handoff.refresh(f.task.id, f.view);
  await Promise.race([entered.promise, pending.then(() => { throw new Error('import completed before the fixture gate'); })]);
  let release: (() => void) | undefined;
  if (change === 'active') await f.store.saveView(f.task.id, { ...f.view, status: 'active' });
  else release = await f.worlds.holdAccess(f.task.id);
  try {
    finish.resolve();
    expect(await pending).toMatchObject({ parked: false, warning: expect.any(String) });
    expect(f.park).not.toHaveBeenCalled();
    expect(f.scrubSecrets).not.toHaveBeenCalled();
    expect(await f.store.activeWorldLeaseCount(f.task.id)).toBe(1);
  } finally { release?.(); }
});

it('releases a newly acquired lease exactly once if opening fails', async () => {
  const f = await fixture();
  f.open.mockRejectedValue(new Error('provider unavailable'));
  await expect(f.handoff.refresh(f.task.id, f.view)).rejects.toThrow('provider unavailable');
  expect(f.runners.release).toHaveBeenCalledOnce();
  expect(await f.store.activeWorldLeaseCount(f.task.id)).toBe(0);
  expect((await f.store.currentWorld(f.task.id))?.meta?.worldLeaseId).toBeNull();
});
