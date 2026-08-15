import { describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { RunnerPoolService, WorldLifecycleManager } from '../src/world/runners.js';
import { WorldRegistry } from '../src/world/registry.js';
import { WorldAccessService } from '../src/world/access.js';

describe('runner capacity and world lifecycle', () => {
  it('inherits one organization execution policy and keeps project overrides sparse', () => {
    const store = new Store(':memory:');
    const organization = store.createOrganization({ name: 'Infrastructure', ownerUserId: 'owner' });
    const project = store.createProject('Product', {}, organization.id);

    expect(store.effectiveProjectConfig(project)).toMatchObject({
      worldProvider: 'worktree', resources: { cpu: 2, memoryMb: 2048, gpu: 0 },
      network: { unrestricted: true }, hibernateAfterMs: 7 * 24 * 60 * 60 * 1000,
    });
    store.createRunnerPool({ id: 'shared', organizationId: organization.id, name: 'Shared', provider: 'daytona',
      mode: 'managed', capacity: { activeWorlds: 10, cpu: 40, memoryMb: 81920, gpu: 0 }, enabled: true });
    store.setOrganizationExecutionPolicy(organization.id, {
      worldProvider: 'daytona', runnerPoolId: 'shared', resources: { cpu: 4, memoryMb: 8192, gpu: 0 },
      network: { unrestricted: false, allowDomains: ['registry.npmjs.org'] },
      monthlyBudgetMicros: 25_000_000, hibernateAfterMs: 24 * 60 * 60 * 1000,
    });
    expect(store.effectiveProjectConfig(project)).toMatchObject({
      worldProvider: 'daytona', runnerPoolId: 'shared', resources: { cpu: 4, memoryMb: 8192 },
      network: { unrestricted: false, allowDomains: ['registry.npmjs.org'] },
    });

    const overridden = store.setProjectExecutionPolicy(project.id, {
      worldProvider: 'e2b', runnerPoolId: null, monthlyBudgetMicros: 5_000_000,
    });
    expect(overridden.config).toEqual({ worldProvider: 'e2b', monthlyBudgetMicros: 5_000_000 });
    expect(store.effectiveProjectConfig(overridden)).toMatchObject({
      worldProvider: 'e2b', resources: { cpu: 4, memoryMb: 8192 }, monthlyBudgetMicros: 5_000_000,
    });
    expect(store.effectiveProjectConfig(overridden).runnerPoolId).toBeUndefined();
    expect(() => store.setProjectExecutionPolicy(project.id, { monthlyBudgetMicros: 30_000_000 }))
      .toThrow(/cannot exceed/);
    expect(store.setProjectExecutionPolicy(project.id, { worldProvider: null, monthlyBudgetMicros: null }).config).toEqual({});
  });

  it('queues by durable capacity, activates on release, and attributes lease-priced provider cost', async () => {
    const store = new Store(':memory:');
    const organization = store.createOrganization({ name: 'Capacity', ownerUserId: 'owner' });
    const project = store.createProject('Cloud', { worldProvider: 'daytona', runnerPoolId: 'tiny', resources: { cpu: 2, memoryMb: 2048 } }, organization.id);
    store.createRunnerPool({ id: 'tiny', organizationId: organization.id, name: 'Tiny', provider: 'daytona', mode: 'managed',
      capacity: { activeWorlds: 1, cpu: 2, memoryMb: 2048, gpu: 0 }, enabled: true });
    const one = createTask(store, project.id, 'One');
    const two = createTask(store, project.id, 'Two');
    const runners = new RunnerPoolService(store);
    const first = await runners.acquire({ project, taskId: one.id, worldId: one.id, provider: 'daytona', pollMs: 5 });
    const secondPromise = runners.acquire({ project, taskId: two.id, worldId: two.id, provider: 'daytona', priority: 10, pollMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(store.listWorldLeases('tiny').map((lease) => lease.state)).toEqual(['active', 'queued']);
    runners.release(first.leaseId, 'daytona');
    const second = await secondPromise;
    expect(store.worldLease(second.leaseId).state).toBe('active');
    runners.release(second.leaseId, 'daytona');
    expect(store.usageSummary(organization.id).events).toBe(2);
  });

  it('never mistakes an E2B runner lease for continuously billed sandbox time', async () => {
    const store = new Store(':memory:');
    const organization = store.createOrganization({ name: 'Metering', ownerUserId: 'owner' });
    const project = store.createProject('Cloud', { worldProvider: 'e2b' }, organization.id);
    const task = createTask(store, project.id, 'Stale');
    const runners = new RunnerPoolService(store);
    const lease = await runners.acquire({ project, taskId: task.id, worldId: task.id, provider: 'e2b' });

    // A real E2B sandbox auto-pauses while a stale karmax lease can remain active
    // for days. Releasing capacity must not turn that wall-clock interval into a
    // provider charge; lifecycle reconciliation records the actual executions.
    store.db.prepare('UPDATE world_leases SET acquiredAt=? WHERE id=?')
      .run(Date.now() - 10 * 24 * 60 * 60_000, lease.leaseId);
    runners.release(lease.leaseId, 'e2b');

    expect(store.usageSummary(organization.id)).toMatchObject({ costMicros: 0, events: 0 });
  });

  it('reconciles provider executions idempotently with actual E2B resources and runtime', async () => {
    const store = new Store(':memory:');
    const organization = store.createOrganization({ name: 'Reconciled', ownerUserId: 'owner' });
    const project = store.createProject('Cloud', { worldProvider: 'e2b' }, organization.id);
    const task = store.createTask({ projectId: project.id, title: 'Run', workflow: 'just-do',
      workflowVersion: '1.0.0', params: { prompt: 'x' } as any });
    store.upsertWorldProviderConnection({ organizationId: organization.id, provider: 'e2b',
      credentialHandle: 'test:e2b', enabled: true });
    const worlds = new WorldRegistry();
    worlds.register({ kind: 'e2b', parkable: true,
      async listUsageEvents() {
        return [{ id: 'execution-1', sandboxId: 'sandbox-1', taskId: task.id,
          startedAt: Date.UTC(2026, 6, 31, 10), endedAt: Date.UTC(2026, 6, 31, 10, 5),
          activeMs: 300_000, cpu: 2, memoryMb: 512 }];
      } } as any);
    const lifecycle = new WorldLifecycleManager(store, worlds, {} as any, 1_000);

    await lifecycle.sweep(Date.UTC(2026, 6, 31, 10, 6));
    await lifecycle.sweep(Date.UTC(2026, 6, 31, 10, 7));

    // 5 minutes × (2 × $0.000014/vCPU/s + 0.5 × $0.0000045/GiB/s)
    expect(store.usageSummary(organization.id)).toEqual({
      costMicros: 9_075, events: 1, byKind: { 'world.active': 9_075 },
      byFundingSource: { byok: 9_075 }, byProvider: { e2b: 9_075 }, quantities: { second: 300 },
      requests: { total: 0, managed: 0, byok: 0, customer: 0 },
      active: { agentTurns: 0, worlds: 0, executions: 0 },
    });
    expect(JSON.parse(store.kvGet(`usage-sync:${organization.id}:e2b`)!)).toMatchObject({
      status: 'ready', coverageFrom: Date.UTC(2026, 6, 24, 10, 6), retentionDays: 7,
    });
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
    const oversizedTask = createTask(store, oversized.id, 'Large');
    await expect(runners.acquire({ project: oversized, taskId: oversizedTask.id, worldId: oversizedTask.id, provider: 'daytona' })).rejects.toThrow(/exceeds/);
  });

  it('admits model usage idempotently with managed opt-in, allowlists, rate limits, and tenant attribution', () => {
    const store = new Store(':memory:');
    const organization = store.createOrganization({ name: 'Guarded', ownerUserId: 'owner' });
    const project = store.createProject('Product', {}, organization.id);
    const first = createTask(store, project.id, 'First');
    const second = createTask(store, project.id, 'Second');

    expect(() => store.admitAgentUsage({ id: 'turn-1', organizationId: organization.id, projectId: project.id,
      taskId: first.id, provider: 'openai', model: 'gpt-approved', fundingSource: 'managed', now: 1_000_000 }))
      .toThrow(/disabled until an organization owner sets a spend cap/);
    store.setOrganizationUsagePolicy(organization.id, { managedSpendCapMicros: 1_000_000,
      managedModelProviders: ['openai'], allowedModelProviders: ['openai'], allowedModels: ['gpt-approved'],
      maxAgentStartsPerMinute: 2, maxActiveAgentTurns: 1 });
    expect(() => store.admitAgentUsage({ id: 'wrong-model', organizationId: organization.id, projectId: project.id,
      taskId: first.id, provider: 'openai', model: 'gpt-other', fundingSource: 'byok', now: 1_000_000 }))
      .toThrow(/not allowed/);
    expect(() => store.admitAgentUsage({ id: 'unbounded-managed', organizationId: organization.id, projectId: project.id,
      taskId: first.id, provider: 'openai', model: 'gpt-approved', fundingSource: 'managed', now: 1_000_000 }))
      .toThrow(/no installation-configured per-request cost ceiling/);
    expect(store.admitAgentUsage({ id: 'turn-1', organizationId: organization.id, projectId: project.id,
      taskId: first.id, provider: 'openai', model: 'gpt-approved', fundingSource: 'managed',
      reservedCostMicros: 250_000, now: 1_000_000 }))
      .toEqual({ reused: false });
    expect(store.admitAgentUsage({ id: 'turn-1', organizationId: organization.id, projectId: project.id,
      taskId: first.id, provider: 'openai', model: 'gpt-approved', fundingSource: 'managed',
      reservedCostMicros: 250_000, now: 1_000_001 }))
      .toEqual({ reused: true });
    expect(() => store.admitAgentUsage({ id: 'turn-2', organizationId: organization.id, projectId: project.id,
      taskId: second.id, provider: 'openai', model: 'gpt-approved', fundingSource: 'byok', now: 1_000_002 }))
      .toThrow(/active model turn limit/);

    store.recordUsage({ id: 'usage:turn-1', organizationId: organization.id, projectId: project.id, taskId: first.id,
      provider: 'openai', kind: 'agent.tokens', quantity: 42, unit: 'token', costMicros: 1_000_000,
      fundingSource: 'managed', startedAt: 1_000_000, endedAt: 1_000_000 });
    store.finishUsageAdmission('turn-1', true, 1_000_010);
    expect(() => store.admitAgentUsage({ id: 'turn-1', organizationId: organization.id, projectId: project.id,
      taskId: first.id, provider: 'openai', model: 'gpt-approved', fundingSource: 'managed',
      reservedCostMicros: 250_000, now: 1_000_011 }))
      .toThrow(/spend cap is exhausted|already completed/);
    expect(store.admitAgentUsage({ id: 'turn-2', organizationId: organization.id, projectId: project.id,
      taskId: second.id, provider: 'openai', model: 'gpt-approved', fundingSource: 'byok', now: 1_000_012 }))
      .toEqual({ reused: false });
    expect(() => store.admitAgentUsage({ id: 'turn-3', organizationId: organization.id, projectId: project.id,
      taskId: first.id, provider: 'openai', model: 'gpt-approved', fundingSource: 'byok', now: 1_000_013 }))
      .toThrow(/rate limit/);

    expect(store.usageSummary(organization.id, 0, 2_000_000)).toMatchObject({
      costMicros: 1_000_000, byFundingSource: { managed: 1_000_000 },
      byProvider: { openai: 1_000_000 }, quantities: { token: 42 }, active: { agentTurns: 1 },
    });
  });

  it('retries a released managed turn without reserving or debiting its request twice', () => {
    const store = new Store(':memory:');
    const organization = store.createOrganization({ name: 'Retry safe', ownerUserId: 'owner' });
    const project = store.createProject('Product', {}, organization.id);
    const task = createTask(store, project.id, 'Retry');
    store.setOrganizationUsagePolicy(organization.id, { managedSpendCapMicros: 250_000,
      managedModelProviders: ['openai'] });
    const admission = { id: 'stable-turn', organizationId: organization.id, projectId: project.id,
      taskId: task.id, provider: 'openai', model: 'gpt-test', fundingSource: 'managed' as const,
      reservedCostMicros: 250_000, now: 1_000_000 };
    expect(store.admitAgentUsage(admission)).toEqual({ reused: false });
    store.recordUsage({ id: 'usage:request:stable-turn', organizationId: organization.id, projectId: project.id,
      taskId: task.id, provider: 'openai', kind: 'agent.request', quantity: 1, unit: 'request',
      costMicros: 250_000, fundingSource: 'managed', startedAt: 1_000_000, endedAt: 1_000_000 });
    store.finishUsageAdmission(admission.id, false, 1_000_001);
    expect(store.admitAgentUsage({ ...admission, now: 1_000_002 })).toEqual({ reused: true });
    expect(store.usageSummary(organization.id, 0, 2_000_000)).toMatchObject({
      costMicros: 250_000, events: 1, requests: { total: 1, managed: 1 }, active: { agentTurns: 1 },
    });
  });

  it('keeps hosted remote execution BYOK by default and refuses centrally funded pools', async () => {
    const previous = process.env.KARMAX_DEPLOYMENT;
    process.env.KARMAX_DEPLOYMENT = 'hosted';
    try {
      const store = new Store(':memory:');
      const organization = store.createOrganization({ name: 'BYOK', ownerUserId: 'owner' });
      const project = store.createProject('Cloud', { worldProvider: 'e2b' }, organization.id);
      const task = createTask(store, project.id, 'Run');
      const runners = new RunnerPoolService(store);
      store.createRunnerPool({ id: `${organization.id}:managed-e2b`, organizationId: organization.id,
        name: 'Legacy managed E2B', provider: 'e2b', mode: 'managed',
        capacity: { activeWorlds: 1, cpu: 40, memoryMb: 81920, gpu: 0 }, enabled: true });
      const pool = runners.ensureDefaultPool(project, 'e2b');
      expect(pool).toMatchObject({ mode: 'customer', provider: 'e2b', name: 'E2B · organization BYOK' });
      store.setOrganizationUsagePolicy(organization.id, { maxRemoteStartsPerMinute: 1 });
      const lease = await runners.acquire({ project, taskId: task.id, worldId: task.id, provider: 'e2b' });
      const queuedTask = createTask(store, project.id, 'Queued');
      const queued = store.requestWorldLease({ runnerPoolId: pool.id, organizationId: organization.id,
        projectId: project.id, taskId: queuedTask.id, worldId: queuedTask.id });
      expect(queued.acquired).toBe(false);
      runners.release(lease.leaseId, 'e2b');
      expect(store.worldLease(queued.id).state).toBe('queued');

      store.createRunnerPool({ id: 'resold-e2b', organizationId: organization.id, name: 'Resold', provider: 'e2b',
        mode: 'managed', capacity: { activeWorlds: 1, cpu: 2, memoryMb: 2048, gpu: 0 }, enabled: true });
      const blocked = store.createProject('Blocked', { worldProvider: 'e2b', runnerPoolId: 'resold-e2b' }, organization.id);
      const blockedTask = createTask(store, blocked.id, 'Blocked');
      await expect(runners.acquire({ project: blocked, taskId: blockedTask.id, worldId: blockedTask.id, provider: 'e2b' }))
        .rejects.toThrow(/centrally funded remote sandbox pools are not enabled/);
    } finally {
      if (previous === undefined) delete process.env.KARMAX_DEPLOYMENT;
      else process.env.KARMAX_DEPLOYMENT = previous;
    }
  });

  it('accounts non-workflow access and reparks a remote world when the last accessor leaves', async () => {
    const store = new Store(':memory:');
    const organization = store.createOrganization({ name: 'Access', ownerUserId: 'owner' });
    const project = store.createProject('Cloud', { worldProvider: 'e2b' }, organization.id);
    const task = store.createTask({ projectId: project.id, title: 'Inspect', workflow: 'just-do',
      workflowVersion: '1.0.0', params: { prompt: 'x' } as any });
    const handle = store.registerWorld({ version: 2, kind: 'e2b', provider: 'e2b', id: task.id, generation: 1,
      root: '/workspace', workspaceRoot: '/workspace', branch: `karmax/${task.id}`, base: 'main',
      meta: { projectId: project.id } }, project.id) as any;
    let parked = 0;
    const world = { handle, listFiles: async () => [], readFile: async () => '', readFileBuffer: async () => Buffer.alloc(0),
      writeFile: async () => {}, exec: async () => ({ stdout: '', stderr: '', code: 0 }),
      startProcess: async () => { throw new Error('unused'); }, openPty: async () => { throw new Error('unused'); },
      destroy: async () => {} } as any;
    const worlds = new WorldRegistry();
    worlds.register({ kind: 'e2b', capabilities: { remote: true }, parkable: true, open: async () => world,
      park: async () => { parked++; return handle; }, status: async () => parked ? 'parked' : 'ready' } as any);
    const accessService = new WorldAccessService(store, worlds, new RunnerPoolService(store));
    const access = await accessService.open(task.id, handle);
    expect(store.activeWorldLeaseCount(task.id)).toBe(1);
    const borrowed = await accessService.open(task.id, handle);
    expect(borrowed.runnerLeaseId).toBeUndefined();
    await access.release();
    expect(store.activeWorldLeaseCount(task.id)).toBe(0);
    expect(parked).toBe(0);
    await borrowed.release();
    expect(parked).toBe(1);
    expect(store.worldState(task.id)).toBe('parked');
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

  it('marks an active world degraded when the provider reports its sandbox missing', async () => {
    const store = new Store(':memory:');
    const project = store.createProject('Reconcile', {});
    const worlds = new WorldRegistry();
    // Replace the built-in provider with one whose control plane lost the sandbox.
    worlds.register({ kind: 'e2b', parkable: true, async probe() { return 'missing'; } } as any);
    const handle = store.registerWorld({ version: 2, kind: 'e2b', provider: 'e2b', id: 'task-reconcile', generation: 1,
      root: '/w', workspaceRoot: '/w', branch: 'karmax/task-reconcile', base: 'main', meta: {} }, project.id);
    expect(handle.generation).toBe(1);
    const lifecycle = new WorldLifecycleManager(store, worlds, {} as any, 1_000);
    await lifecycle.sweep(Date.now() + 60 * 60_000);
    expect(store.worldState('task-reconcile')).toBe('degraded');
  });

  it('leaves ready worlds alone when the provider has no probe or cannot say', async () => {
    const store = new Store(':memory:');
    const project = store.createProject('Local', {});
    const worlds = new WorldRegistry();
    worlds.register({ kind: 'e2b', parkable: true, async probe() { return undefined; } } as any);
    store.registerWorld({ version: 2, kind: 'e2b', provider: 'e2b', id: 'task-unknown', generation: 1,
      root: '/w', workspaceRoot: '/w', branch: 'karmax/task-unknown', base: 'main', meta: {} }, project.id);
    store.registerWorld({ version: 2, kind: 'memory', provider: 'memory', id: 'task-local', generation: 1,
      root: '/w', workspaceRoot: '/w', branch: 'karmax/task-local', base: 'main', meta: {} }, project.id);
    const lifecycle = new WorldLifecycleManager(store, worlds, {} as any, 1_000);
    await lifecycle.sweep(Date.now() + 60 * 60_000);
    expect(store.worldState('task-unknown')).toBe('ready');
    expect(store.worldState('task-local')).toBe('ready');
  });

  /**
   * Daytona is created with `autoDeleteInterval: -1`, which switches the
   * provider's own reaper OFF on the explicit promise that karmax reaps
   * instead. That promise had no implementation — `listSandboxes` was written
   * on both providers and never called — so a sandbox whose task was deleted
   * before `destroyWorld` ran billed forever with nothing collecting it.
   */
  it('reaps a remote sandbox whose task is gone, and never one it cannot attribute', async () => {
    const store = new Store(':memory:');
    const project = store.createProject('Orphans', {});
    const live = store.createTask({ projectId: project.id, title: 'Live', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'x' } as any });
    const destroyed: string[] = [];
    const ref = (sandboxId: string, taskId?: string) => ({
      sandboxId, ...(taskId ? { taskId } : {}),
      destroy: async () => { destroyed.push(sandboxId); },
    });
    const worlds = new WorldRegistry();
    worlds.register({ kind: 'daytona', parkable: true,
      async listSandboxes() {
        return [
          ref('sb-orphan', 'task-deleted-long-ago'), // task row gone → reap
          ref('sb-live', live.id),                   // task still exists → keep
          ref('sb-unlabelled'),                      // unattributable → never touch
        ];
      } } as any);

    const lifecycle = new WorldLifecycleManager(store, worlds, {} as any, 1_000);
    await lifecycle.sweep(Date.now());

    expect(destroyed).toEqual(['sb-orphan']);
    expect(store.auditSince(0).some((e: { action: string }) => e.action === 'world.orphanReaped')).toBe(true);
  });

  it('reaps duplicate provider allocations after one sandbox is durably registered', async () => {
    const store = new Store(':memory:');
    const project = store.createProject('Duplicate recovery', {});
    const task = store.createTask({ projectId: project.id, title: 'Live', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'x' } as any });
    const handle = store.registerWorld({ version: 2, kind: 'e2b', provider: 'e2b', id: task.id, generation: 1,
      root: '/w', workspaceRoot: '/w', branch: `karmax/${task.id}`, base: 'main', sealedProviderRef: 'sealed-current',
      meta: {} }, project.id);
    const destroyed: string[] = [];
    const worlds = new WorldRegistry();
    worlds.register({ kind: 'e2b', parkable: true,
      async listSandboxes() {
        return [
          { sandboxId: 'current', taskId: task.id,
            matches: (candidate: any) => candidate.sealedProviderRef === handle.sealedProviderRef,
            destroy: async () => { destroyed.push('current'); } },
          { sandboxId: 'duplicate', taskId: task.id, matches: () => false,
            destroy: async () => { destroyed.push('duplicate'); } },
        ];
      } } as any);

    const lifecycle = new WorldLifecycleManager(store, worlds, {} as any, 1_000);
    await lifecycle.sweep(Date.now());

    expect(destroyed).toEqual(['duplicate']);
    expect(store.auditSince(0).find((event: any) => event.detail?.sandboxId === 'duplicate')?.detail)
      .toMatchObject({ reason: 'duplicate' });
  });

  it('keeps sweeping after one provider control plane fails', async () => {
    const store = new Store(':memory:');
    const destroyed: string[] = [];
    const worlds = new WorldRegistry();
    worlds.register({ kind: 'e2b', parkable: true, async listSandboxes() { throw new Error('control plane down'); } } as any);
    worlds.register({ kind: 'daytona', parkable: true,
      async listSandboxes() {
        return [{ sandboxId: 'sb-2', taskId: 'gone', destroy: async () => { destroyed.push('sb-2'); } }];
      } } as any);
    const lifecycle = new WorldLifecycleManager(store, worlds, {} as any, 1_000);
    await expect(lifecycle.sweep(Date.now())).resolves.toBeDefined();
    expect(destroyed).toEqual(['sb-2']);
  });

  it('enumerates every organization-scoped provider connection during orphan cleanup', async () => {
    const store = new Store(':memory:');
    const first = store.createOrganization({ name: 'First tenant', ownerUserId: 'owner-1' });
    const second = store.createOrganization({ name: 'Second tenant', ownerUserId: 'owner-2' });
    for (const organization of [first, second]) store.upsertWorldProviderConnection({
      organizationId: organization.id, provider: 'e2b', credentialHandle: `key:${organization.id}`, enabled: true,
    });
    const scopes: Array<string | undefined> = [];
    const destroyed: string[] = [];
    const worlds = new WorldRegistry();
    worlds.register({ kind: 'e2b', parkable: true,
      async listSandboxes(organizationId?: string) {
        scopes.push(organizationId);
        return [{ sandboxId: `gone:${organizationId}`, taskId: `deleted:${organizationId}`,
          destroy: async () => { destroyed.push(`gone:${organizationId}`); } }];
      } } as any);

    await new WorldLifecycleManager(store, worlds, {} as any, 1_000).sweep(Date.now());

    expect(scopes).toEqual(expect.arrayContaining([first.id, second.id]));
    expect(destroyed).toEqual(expect.arrayContaining([`gone:${first.id}`, `gone:${second.id}`]));
  });

  it('releases runner capacity held by an execution lost during failover', async () => {
    const store = new Store(':memory:');
    const organization = store.createOrganization({ name: 'Recovery', ownerUserId: 'owner' });
    const project = store.createProject('Cloud', { worldProvider: 'e2b' }, organization.id);
    const task = createTask(store, project.id, 'Recover');
    const runners = new RunnerPoolService(store);
    const lease = await runners.acquire({ project, taskId: task.id, worldId: task.id, provider: 'e2b' });
    store.registerWorld({ version: 2, kind: 'e2b', provider: 'e2b', id: task.id, generation: 1,
      root: '/workspace', workspaceRoot: '/workspace', branch: `karmax/${task.id}`, base: 'main', meta: {} }, project.id);
    store.createExecution({ id: 'execution-1', organizationId: organization.id, projectId: project.id,
      taskId: task.id, worldId: task.id, generation: 1, kind: 'terminal', label: 'Terminal',
      server: false, openUrls: [], runnerLeaseId: lease.leaseId, state: 'running', heartbeatAt: 1, startedAt: 1 });
    const lifecycle = new WorldLifecycleManager(store, new WorldRegistry(), {} as any, 1_000, undefined, runners);
    await lifecycle.sweep(3 * 60_000);
    expect(store.execution('execution-1')?.state).toBe('lost');
    expect(store.worldLease(lease.leaseId)?.state).toBe('released');
  });
});

function createTask(store: Store, projectId: string, title: string) {
  return store.createTask({ projectId, title, workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: title } as any });
}
