import { describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { RunnerPoolService, WorldLifecycleManager } from '../src/world/runners.js';
import { WorldRegistry } from '../src/world/registry.js';

describe('runner capacity and world lifecycle', () => {
  it('queues by durable capacity, activates on release, and attributes provider cost', async () => {
    const store = new Store(':memory:');
    const organization = store.createOrganization({ name: 'Capacity', ownerUserId: 'owner' });
    const project = store.createProject('Cloud', { worldProvider: 'e2b', runnerPoolId: 'tiny', resources: { cpu: 2, memoryMb: 2048 } }, organization.id);
    store.createRunnerPool({ id: 'tiny', organizationId: organization.id, name: 'Tiny', provider: 'e2b', mode: 'managed',
      capacity: { activeWorlds: 1, cpu: 2, memoryMb: 2048, gpu: 0 }, enabled: true });
    const runners = new RunnerPoolService(store);
    const first = await runners.acquire({ project, taskId: 'one', worldId: 'one', provider: 'e2b', pollMs: 5 });
    const secondPromise = runners.acquire({ project, taskId: 'two', worldId: 'two', provider: 'e2b', priority: 10, pollMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(store.listWorldLeases('tiny').map((lease) => lease.state)).toEqual(['active', 'queued']);
    runners.release(first.leaseId, 'e2b');
    const second = await secondPromise;
    expect(store.worldLease(second.leaseId).state).toBe('active');
    runners.release(second.leaseId, 'e2b');
    expect(store.usageSummary(organization.id).events).toBe(2);
  });

  it('fails impossible or provider-mismatched reservations instead of queueing forever', async () => {
    const store = new Store(':memory:');
    const organization = store.createOrganization({ name: 'Limits', ownerUserId: 'owner' });
    store.createRunnerPool({ id: 'daytona-only', organizationId: organization.id, name: 'Daytona', provider: 'daytona',
      mode: 'managed', capacity: { activeWorlds: 1, cpu: 2, memoryMb: 2048, gpu: 0 }, enabled: true });
    const runners = new RunnerPoolService(store);
    const wrong = store.createProject('Wrong', { worldProvider: 'e2b', runnerPoolId: 'daytona-only' }, organization.id);
    await expect(runners.acquire({ project: wrong, taskId: 'one', worldId: 'one', provider: 'e2b' })).rejects.toThrow(/not e2b/);
    const oversized = store.createProject('Large', { worldProvider: 'daytona', runnerPoolId: 'daytona-only',
      resources: { cpu: 4, memoryMb: 2048 } }, organization.id);
    await expect(runners.acquire({ project: oversized, taskId: 'two', worldId: 'two', provider: 'daytona' })).rejects.toThrow(/exceeds/);
  });

  it('hibernates parked worlds only after a portable checkpoint exists', async () => {
    const store = new Store(':memory:');
    const project = store.createProject('Lifecycle', { hibernateAfterMs: 0 });
    const worlds = new WorldRegistry();
    const world = await worlds.create('memory', { taskId: 'world-1', base: 'main' });
    world.handle.meta = { projectId: project.id };
    world.handle = store.registerWorld(world.handle, project.id) as typeof world.handle;
    store.saveWorldCheckpoint({ id: 'checkpoint-1', worldId: world.handle.id, generation: 1, projectId: project.id,
      runnerPoolId: 'local', environmentDigest: 'test', repos: [], createdAt: Date.now() });
    store.setWorldState(world.handle, 'parked');
    const lifecycle = new WorldLifecycleManager(store, worlds, {} as any, 1_000);
    expect(await lifecycle.sweep(Date.now() + 1)).toBe(1);
    expect(store.worldState(world.handle.id)).toBe('hibernated');
  });

  it('releases runner capacity held by an execution lost during failover', async () => {
    const store = new Store(':memory:');
    const organization = store.createOrganization({ name: 'Recovery', ownerUserId: 'owner' });
    const project = store.createProject('Cloud', { worldProvider: 'e2b' }, organization.id);
    const runners = new RunnerPoolService(store);
    const lease = await runners.acquire({ project, taskId: 'task-1', worldId: 'task-1', provider: 'e2b' });
    store.registerWorld({ version: 2, kind: 'e2b', provider: 'e2b', id: 'task-1', generation: 1,
      root: '/workspace', workspaceRoot: '/workspace', branch: 'karmax/task-1', base: 'main', meta: {} }, project.id);
    store.createExecution({ id: 'execution-1', organizationId: organization.id, projectId: project.id,
      taskId: 'task-1', worldId: 'task-1', generation: 1, kind: 'terminal', label: 'Terminal',
      server: false, openUrls: [], runnerLeaseId: lease.leaseId, state: 'running', heartbeatAt: 1, startedAt: 1 });
    const lifecycle = new WorldLifecycleManager(store, new WorldRegistry(), {} as any, 1_000, undefined, runners);
    await lifecycle.sweep(3 * 60_000);
    expect(store.execution('execution-1')?.state).toBe('lost');
    expect(store.worldLease(lease.leaseId)?.state).toBe('released');
  });
});
