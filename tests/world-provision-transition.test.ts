import { afterEach, expect, it, vi } from 'vitest';
import { Context } from '@temporalio/activity';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';
import { WorldLifecycleManager } from '../src/world/runners.js';
import { makeCoreActivities } from '../src/activities/core.js';
import { ProfileResolver } from '../src/agent/profiles.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
let store: Store;
afterEach(async () => { vi.restoreAllMocks(); await store?.close(); });

it('protects a replacement allocation from orphan cleanup until provisioning registers it', async () => {
  store = await Store.create(':memory:');
  const project = await store.createProject('Provisioning');
  const task = await store.createTask({ projectId: project.id, title: 'Replacement', workflow: 'software-dev',
    workflowVersion: '1.0.0', params: { prompt: 'fixture' } });
  const old = await store.registerWorld({ id: task.id, kind: 'memory', root: '/fixture',
    branch: 'task', base: 'main', sealedProviderRef: 'old' }, project.id);
  const entered = deferred(), finish = deferred(), listed = deferred();
  const destroyed = vi.fn(async () => {});
  const handle = { ...old, generation: 2, sealedProviderRef: 'new' };
  const worlds = new WorldRegistry();
  worlds.register({ kind: 'memory',
    create: async () => ({ handle, destroy: destroyed }),
    listSandboxes: async () => {
      listed.resolve();
      return [{ taskId: task.id, sandboxId: 'new',
        matches: (current: any) => current.sealedProviderRef === 'new', destroy: destroyed }];
    },
  } as any);
  const core = makeCoreActivities({ store, worlds, adapters: new Map(), profiles: new ProfileResolver(store, 'mock'),
    resources: { materialize: async () => { entered.resolve(); await finish.promise; return handle; } } as any });
  const creating = core.createWorld({ taskId: task.id, projectId: project.id, kind: 'memory', base: 'main' });
  await Promise.race([entered.promise, creating.then(() => { throw new Error('provisioning gate not reached'); })]);
  const lifecycle = new WorldLifecycleManager(store, worlds, {} as any);
  const sweeping = lifecycle.sweep();
  await listed.promise;
  await new Promise(resolve => setImmediate(resolve));
  try { expect(destroyed).not.toHaveBeenCalled(); }
  finally { finish.resolve(); await creating; await sweeping; }
  expect(destroyed).not.toHaveBeenCalled();
  expect(await store.currentWorld(task.id)).toMatchObject({ generation: 2, sealedProviderRef: 'new' });
});


it('RT-6 heartbeats local provisioning until durable registration completes', async () => {
  store = await Store.create(':memory:');
  const entered = deferred(), finish = deferred();
  const heartbeat = vi.fn();
  vi.spyOn(Context, 'current').mockReturnValue({ heartbeat,
    cancellationSignal: new AbortController().signal } as any);
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const worlds = new WorldRegistry();
  worlds.register({ kind: 'memory', create: async () => {
    entered.resolve(); await finish.promise;
    return { handle: { id: 'local-slow', kind: 'memory', root: '/fixture', base: 'main', branch: 'task' },
      destroy: async () => {} };
  } } as any);
  const core = makeCoreActivities({ store, worlds, adapters: new Map(), profiles: new ProfileResolver(store, 'mock') });
  const creating = core.createWorld({ taskId: 'local-slow', kind: 'memory', base: 'main' });
  await entered.promise;
  try {
    await vi.advanceTimersByTimeAsync(2_000);
    expect(heartbeat).toHaveBeenCalled();
  } finally {
    finish.resolve(); await creating;
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  }
});
