import * as __asyncCollections from '../src/util/async-collections.js';
import { describe, expect, it, vi } from 'vitest';
import { Store } from '../src/store/db.js';
import { RunnerPoolService, WorldLifecycleManager } from '../src/world/runners.js';
import { WorldRegistry } from '../src/world/registry.js';
import { WorldAccessService } from '../src/world/access.js';

describe('runner capacity and world lifecycle', () => {
  it('inherits one organization execution policy and keeps project overrides sparse', async () => {
    const store = (await Store.create(':memory:'));
    const organization = (await store.createOrganization({ name: 'Infrastructure', ownerUserId: 'owner' }));
    const project = (await store.createProject('Product', {}, organization.id));

    expect((await store.effectiveProjectConfig(project))).toMatchObject({
      worldProvider: 'worktree', resources: { cpu: 2, memoryMb: 2048, gpu: 0 },
      network: { unrestricted: true }, hibernateAfterMs: 7 * 24 * 60 * 60 * 1000,
    });
    (await store.createRunnerPool({ id: 'shared', organizationId: organization.id, name: 'Shared', provider: 'daytona',
      mode: 'managed', capacity: { activeWorlds: 10, cpu: 40, memoryMb: 81920, gpu: 0 }, enabled: true }));
    (await store.setOrganizationExecutionPolicy(organization.id, {
      worldProvider: 'daytona', runnerPoolId: 'shared', resources: { cpu: 4, memoryMb: 8192, gpu: 0 },
      network: { unrestricted: false, allowDomains: ['registry.npmjs.org'] },
      monthlyBudgetMicros: 25_000_000, hibernateAfterMs: 24 * 60 * 60 * 1000,
    }));
    expect((await store.effectiveProjectConfig(project))).toMatchObject({
      worldProvider: 'daytona', runnerPoolId: 'shared', resources: { cpu: 4, memoryMb: 8192 },
      network: { unrestricted: false, allowDomains: ['registry.npmjs.org'] },
    });

    const overridden = (await store.setProjectExecutionPolicy(project.id, {
      worldProvider: 'e2b', runnerPoolId: null, monthlyBudgetMicros: 5_000_000,
    }));
    expect(overridden.config).toEqual({ worldProvider: 'e2b', monthlyBudgetMicros: 5_000_000 });
    expect((await store.effectiveProjectConfig(overridden))).toMatchObject({
      worldProvider: 'e2b', resources: { cpu: 4, memoryMb: 8192 }, monthlyBudgetMicros: 5_000_000,
    });
    expect((await store.effectiveProjectConfig(overridden)).runnerPoolId).toBeUndefined();
    await expect((async () => (await store.setProjectExecutionPolicy(project.id, { monthlyBudgetMicros: 30_000_000 })))()).rejects.toThrow(/cannot exceed/);
    expect((await store.setProjectExecutionPolicy(project.id, { worldProvider: null, monthlyBudgetMicros: null })).config).toEqual({});
  });

  it('queues by durable capacity, activates on release, and attributes lease-priced provider cost', async () => {
    const store = (await Store.create(':memory:'));
    const organization = (await store.createOrganization({ name: 'Capacity', ownerUserId: 'owner' }));
    const project = (await store.createProject('Cloud', { worldProvider: 'daytona', runnerPoolId: 'tiny', resources: { cpu: 2, memoryMb: 2048 } }, organization.id));
    (await store.createRunnerPool({ id: 'tiny', organizationId: organization.id, name: 'Tiny', provider: 'daytona', mode: 'managed',
      capacity: { activeWorlds: 1, cpu: 2, memoryMb: 2048, gpu: 0 }, enabled: true }));
    const one = (await createTask(store, project.id, 'One'));
    const two = (await createTask(store, project.id, 'Two'));
    const runners = new RunnerPoolService(store);
    const first = await runners.acquire({ project, taskId: one.id, worldId: one.id, provider: 'daytona', pollMs: 5 });
    const secondPromise = runners.acquire({ project, taskId: two.id, worldId: two.id, provider: 'daytona', priority: 10, pollMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect((await store.listWorldLeases('tiny')).map((lease) => lease.state)).toEqual(['active', 'queued']);
    (await runners.release(first.leaseId, 'daytona'));
    const second = await secondPromise;
    expect((await store.worldLease(second.leaseId)).state).toBe('active');
    (await runners.release(second.leaseId, 'daytona'));
    expect((await store.usageSummary(organization.id)).events).toBe(2);
  });

  it('never mistakes an E2B runner lease for continuously billed sandbox time', async () => {
    const store = (await Store.create(':memory:'));
    const organization = (await store.createOrganization({ name: 'Metering', ownerUserId: 'owner' }));
    const project = (await store.createProject('Cloud', { worldProvider: 'e2b' }, organization.id));
    const task = (await createTask(store, project.id, 'Stale'));
    const runners = new RunnerPoolService(store);
    const lease = await runners.acquire({ project, taskId: task.id, worldId: task.id, provider: 'e2b' });

    // A real E2B sandbox auto-pauses while a stale karmax lease can remain active
    // for days. Releasing capacity must not turn that wall-clock interval into a
    // provider charge; lifecycle reconciliation records the actual executions.
    (await store.db.prepare('UPDATE world_leases SET acquiredAt=? WHERE id=?')
      .run(Date.now() - 10 * 24 * 60 * 60_000, lease.leaseId));
    (await runners.release(lease.leaseId, 'e2b'));

    expect((await store.usageSummary(organization.id))).toMatchObject({ costMicros: 0, events: 0 });
  });

  it('reclaims setup capacity from terminal tasks and admits the next waiter', async () => {
    const store = (await Store.create(':memory:'));
    const organization = (await store.createOrganization({ name: 'Recovery', ownerUserId: 'owner' }));
    const project = (await store.createProject('Cloud', { worldProvider: 'e2b', runnerPoolId: 'tiny' }, organization.id));
    (await store.createRunnerPool({ id: 'tiny', organizationId: organization.id, name: 'Tiny', provider: 'e2b', mode: 'managed',
      capacity: { activeWorlds: 1, cpu: 2, memoryMb: 2048, gpu: 0 }, enabled: true }));
    const cancelled = (await store.createTask({ projectId: project.id, title: 'Cancelled setup', workflow: 'software-dev',
      workflowVersion: '1.25.0', params: { prompt: 'x' } as any }));
    const next = (await store.createTask({ projectId: project.id, title: 'Next setup', workflow: 'software-dev',
      workflowVersion: '1.25.0', params: { prompt: 'x' } as any }));
    const first = (await store.requestWorldLease({ runnerPoolId: 'tiny', organizationId: organization.id,
      projectId: project.id, taskId: cancelled.id, worldId: cancelled.id }));
    const second = (await store.requestWorldLease({ runnerPoolId: 'tiny', organizationId: organization.id,
      projectId: project.id, taskId: next.id, worldId: next.id }));
    (await store.saveView(cancelled.id, {
      taskId: cancelled.id, title: cancelled.title, workflow: cancelled.workflow, stage: 'cancelled',
      status: 'cancelled', messages: [], actions: [], state: { cancelled: true }, updatedAt: Date.now(),
    }));
    const runners = new RunnerPoolService(store);

    await new WorldLifecycleManager(store, new WorldRegistry(), {} as any, 1_000, undefined, runners).sweep(Date.now());

    expect((await store.worldLease(first.id))?.state).toBe('released');
    expect((await store.worldLease(second.id))?.state).toBe('active');
  });

  it('releases a failed admission reservation when its Temporal heartbeat disappears', async () => {
    const store = (await Store.create(':memory:'));
    const organization = (await store.createOrganization({ name: 'Timed out admission', ownerUserId: 'owner' }));
    const project = (await store.createProject('Cloud', { worldProvider: 'e2b', runnerPoolId: 'tiny' }, organization.id));
    (await store.createRunnerPool({ id: 'tiny', organizationId: organization.id, name: 'Tiny', provider: 'e2b', mode: 'managed',
      capacity: { activeWorlds: 1, cpu: 2, memoryMb: 2048, gpu: 0 }, enabled: true }));
    const runners = new RunnerPoolService(store);
    const heldTask = (await createTask(store, project.id, 'Held'));
    const timedOutTask = (await createTask(store, project.id, 'Timed out'));
    const held = await runners.acquire({ project, taskId: heldTask.id, worldId: heldTask.id, provider: 'e2b' });

    await expect(runners.acquire({ project, taskId: timedOutTask.id, worldId: timedOutTask.id, provider: 'e2b', pollMs: 5,
      heartbeat: () => { throw new Error('NOT_FOUND'); } })).rejects.toThrow('NOT_FOUND');

    expect((await store.worldLeasesForTask(timedOutTask.id))).toEqual([]);
    (await runners.release(held.leaseId, 'e2b'));
  });

  it('reclaims old active capacity from a parked nonterminal world', async () => {
    const store = (await Store.create(':memory:'));
    const organization = (await store.createOrganization({ name: 'Parked recovery', ownerUserId: 'owner' }));
    const project = (await store.createProject('Cloud', { worldProvider: 'e2b', runnerPoolId: 'tiny' }, organization.id));
    (await store.createRunnerPool({ id: 'tiny', organizationId: organization.id, name: 'Tiny', provider: 'e2b', mode: 'managed',
      capacity: { activeWorlds: 1, cpu: 2, memoryMb: 2048, gpu: 0 }, enabled: true }));
    const task = (await store.createTask({ projectId: project.id, title: 'Still working', workflow: 'software-dev',
      workflowVersion: '1.25.0', params: { prompt: 'x' } as any }));
    const handle = (await store.registerWorld({ version: 2, kind: 'e2b', provider: 'e2b', id: task.id, generation: 1,
      root: '/workspace', workspaceRoot: '/workspace', branch: `karmax/${task.id}`, base: 'main',
      meta: { projectId: project.id } }, project.id));
    (await store.setWorldState(handle, 'parked'));
    const stale = (await store.requestWorldLease({ runnerPoolId: 'tiny', organizationId: organization.id,
      projectId: project.id, taskId: task.id, worldId: task.id }));
    const now = Date.now();
    (await store.db.prepare('UPDATE world_leases SET createdAt=?, acquiredAt=? WHERE id=?')
      .run(now - 3 * 60_000, now - 3 * 60_000, stale.id));

    await new WorldLifecycleManager(store, new WorldRegistry(), {} as any, 1_000, undefined,
      new RunnerPoolService(store)).sweep(now);

    expect((await store.worldLease(stale.id))?.state).toBe('released');
  });

  it('keeps a newly admitted wake-up while it marks its parked world ready', async () => {
    const store = (await Store.create(':memory:'));
    const organization = (await store.createOrganization({ name: 'Wake-up grace', ownerUserId: 'owner' }));
    const project = (await store.createProject('Cloud', { worldProvider: 'e2b' }, organization.id));
    const task = (await store.createTask({ projectId: project.id, title: 'Waking', workflow: 'software-dev',
      workflowVersion: '1.25.0', params: { prompt: 'x' } as any }));
    const handle = (await store.registerWorld({ version: 2, kind: 'e2b', provider: 'e2b', id: task.id, generation: 1,
      root: '/workspace', workspaceRoot: '/workspace', branch: `karmax/${task.id}`, base: 'main',
      meta: { projectId: project.id } }, project.id));
    (await store.setWorldState(handle, 'parked'));
    const runners = new RunnerPoolService(store);
    const lease = await runners.acquire({ project, taskId: task.id, worldId: task.id, provider: 'e2b' });

    await new WorldLifecycleManager(store, new WorldRegistry(), {} as any, 1_000, undefined, runners).sweep(Date.now());

    expect((await store.worldLease(lease.leaseId))?.state).toBe('active');
    (await runners.release(lease.leaseId, 'e2b'));
  });

  it('preserves old capacity explicitly borrowed by a live preview', async () => {
    const store = (await Store.create(':memory:'));
    const organization = (await store.createOrganization({ name: 'Preview capacity', ownerUserId: 'owner' }));
    const project = (await store.createProject('Cloud', { worldProvider: 'e2b' }, organization.id));
    const task = (await store.createTask({ projectId: project.id, title: 'Finished with preview', workflow: 'software-dev',
      workflowVersion: '1.25.0', params: { prompt: 'x' } as any }));
    (await store.saveView(task.id, { taskId: task.id, title: task.title, workflow: task.workflow, stage: 'done',
      status: 'done', messages: [], actions: [], state: {}, updatedAt: Date.now() }));
    const handle = (await store.registerWorld({ version: 2, kind: 'e2b', provider: 'e2b', id: task.id, generation: 1,
      root: '/workspace', workspaceRoot: '/workspace', branch: `karmax/${task.id}`, base: 'main',
      meta: { projectId: project.id } }, project.id));
    const runners = new RunnerPoolService(store);
    const lease = await runners.acquire({ project, taskId: task.id, worldId: task.id, provider: 'e2b' });
    const orphan = await runners.acquire({ project, taskId: task.id, worldId: task.id, provider: 'e2b' });
    const now = Date.now();
    (await store.db.prepare('UPDATE world_leases SET createdAt=?, acquiredAt=? WHERE id IN (?,?)')
      .run(now - 3 * 60_000, now - 3 * 60_000, lease.leaseId, orphan.leaseId));
    (await store.createPreviewLease({ id: 'preview-live', organizationId: organization.id, projectId: project.id,
      taskId: task.id, worldId: task.id, generation: 1, port: 3000, public: false, provider: 'e2b',
      runnerLeaseId: lease.leaseId, createdBy: 'owner', createdAt: now - 3 * 60_000, expiresAt: now + 60_000 }));

    const fullRead = vi.spyOn(store, 'getTask').mockImplementation(() => { throw Error('maintenance loaded history'); });
    await new WorldLifecycleManager(store, new WorldRegistry(), {} as any, 1_000, undefined, runners).sweep(now);
    expect(fullRead).not.toHaveBeenCalled();
    fullRead.mockRestore();

    expect((await store.worldLease(lease.leaseId))?.state).toBe('active');
    expect((await store.worldLease(orphan.leaseId))?.state).toBe('released');
    (await runners.release(lease.leaseId, 'e2b'));
    (await store.setWorldState(handle, 'released'));
  });

  it('reconciles provider executions idempotently with actual E2B resources and runtime', async () => {
    const store = (await Store.create(':memory:'));
    const organization = (await store.createOrganization({ name: 'Reconciled', ownerUserId: 'owner' }));
    const project = (await store.createProject('Cloud', { worldProvider: 'e2b' }, organization.id));
    const task = (await store.createTask({ projectId: project.id, title: 'Run', workflow: 'just-do',
      workflowVersion: '1.0.0', params: { prompt: 'x' } as any }));
    (await store.upsertWorldProviderConnection({ organizationId: organization.id, provider: 'e2b',
      credentialHandle: 'test:e2b', enabled: true }));
    const worlds = new WorldRegistry();
    worlds.register({ kind: 'e2b', parkable: true,
      async listUsageEvents() {
        return [{ id: 'execution-1', sandboxId: 'sandbox-1', taskId: task.id,
          startedAt: Date.UTC(2026, 6, 31, 10), endedAt: Date.UTC(2026, 6, 31, 10, 5),
          activeMs: 300_000, cpu: 2, memoryMb: 512 }];
      } } as any);
    const lifecycle = new WorldLifecycleManager(store, worlds, {} as any, 1_000);

    const record = vi.spyOn(store, 'recordUsage');
    const hydrate = vi.spyOn(store, 'getTask');
    await lifecycle.sweep(Date.UTC(2026, 6, 31, 10, 6));
    // A process restart still recognizes durable execution IDs without redoing
    // attribution, hydrating conversations, or issuing duplicate writes.
    await new WorldLifecycleManager(store, worlds, {} as any).sweep(Date.UTC(2026, 6, 31, 10, 7));
    expect(record).toHaveBeenCalledTimes(1);
    expect(hydrate).not.toHaveBeenCalled();

    // 5 minutes × (2 × $0.000014/vCPU/s + 0.5 × $0.0000045/GiB/s)
    expect((await store.usageSummary(organization.id))).toEqual({
      costMicros: 9_075, events: 1, byKind: { 'world.active': 9_075 },
      incurredCostMicros: 9_075, estimatedCostMicros: 0, activeReservationsMicros: 0,
      byCostClassification: { incurred: 9_075 },
      byFundingSource: { byok: 9_075 }, byProvider: { e2b: 9_075 }, quantities: { second: 300 },
      requests: { total: 0, managed: 0, byok: 0, customer: 0 },
      active: { agentTurns: 0, worlds: 0, executions: 0 },
    });
    expect(JSON.parse((await store.kvGet(`usage-sync:${organization.id}:e2b`))!)).toMatchObject({
      status: 'ready', coverageFrom: Date.UTC(2026, 6, 24, 10, 6), retentionDays: 7,
    });
  });

  it('yields during usage catchup, coalesces sweeps, and imports late events without cross-tenant attribution', async () => {
    const store = (await Store.create(':memory:'));
    const organization = (await store.createOrganization({ name: 'Metered', ownerUserId: 'owner' }));
    const project = (await store.createProject('Cloud', {}, organization.id));
    const task = (await createTask(store, project.id, 'Run'));
    const foreign = (await store.createProject('Foreign', {}, (await store.createOrganization({ name: 'Other', ownerUserId: 'other' })).id));
    const foreignTask = (await createTask(store, foreign.id, 'Other run'));
    (await store.upsertWorldProviderConnection({ organizationId: organization.id, provider: 'e2b', credentialHandle: 'test:e2b', enabled: true }));
    const events = Array.from({ length: 550 }, (_, index) => ({ id: `execution-${index}`, sandboxId: `sandbox-${index}`,
      taskId: index === 0 ? foreignTask.id : task.id, startedAt: 1000, endedAt: 2000, activeMs: 1000, cpu: 1, memoryMb: 512 }));
    const listUsageEvents = vi.fn(async () => events);
    const worlds = new WorldRegistry();
    worlds.register({ kind: 'e2b', parkable: true, listUsageEvents } as any);
    const lifecycle = new WorldLifecycleManager(store, worlds, {} as any);
    const attribution = vi.spyOn(store, 'taskAttribution');
    let recordsAtYield = -1;
    const record = vi.spyOn(store, 'recordUsage');
    const tick = new Promise<void>(resolve => setImmediate(() => { recordsAtYield = record.mock.calls.length; resolve(); }));
    await Promise.all([lifecycle.sweep(), lifecycle.sweep(), tick]);
    expect(listUsageEvents).toHaveBeenCalledTimes(1);
    expect(recordsAtYield).toBeGreaterThan(0);
    expect(recordsAtYield).toBeLessThan(events.length);
    expect(attribution).toHaveBeenCalledTimes(2);
    expect(record.mock.calls[0]![0]).not.toHaveProperty('taskId');
    expect(record.mock.calls[1]![0]).toMatchObject({ taskId: task.id, projectId: project.id, organizationId: organization.id });
    expect((await store.recordedUsageEventIds(events.map(event => `usage:e2b:${event.id}`))).size).toBe(550);
    expect((await store.recordedUsageEventIds([])).size).toBe(0);
    events.push({ ...events[1]!, id: 'late-execution', startedAt: 0, endedAt: 1000 });
    await lifecycle.sweep();
    expect(record).toHaveBeenCalledTimes(551);
    expect((await store.usageSummary(organization.id)).events).toBe(551);
    (await store.close());
  });

  it('fails impossible or provider-mismatched reservations instead of queueing forever', async () => {
    const store = (await Store.create(':memory:'));
    const organization = (await store.createOrganization({ name: 'Limits', ownerUserId: 'owner' }));
    (await store.createRunnerPool({ id: 'daytona-only', organizationId: organization.id, name: 'Daytona', provider: 'daytona',
      mode: 'managed', capacity: { activeWorlds: 1, cpu: 2, memoryMb: 2048, gpu: 0 }, enabled: true }));
    const runners = new RunnerPoolService(store);
    const wrong = (await store.createProject('Wrong', { worldProvider: 'e2b', runnerPoolId: 'daytona-only' }, organization.id));
    await expect(runners.acquire({ project: wrong, taskId: 'one', worldId: 'one', provider: 'e2b' })).rejects.toThrow(/not e2b/);
    const oversized = (await store.createProject('Large', { worldProvider: 'daytona', runnerPoolId: 'daytona-only',
      resources: { cpu: 4, memoryMb: 2048 } }, organization.id));
    const oversizedTask = (await createTask(store, oversized.id, 'Large'));
    await expect(runners.acquire({ project: oversized, taskId: oversizedTask.id, worldId: oversizedTask.id, provider: 'daytona' })).rejects.toThrow(/exceeds/);
  });

  it('admits model usage idempotently with managed opt-in, allowlists, rate limits, and tenant attribution', async () => {
    const store = (await Store.create(':memory:'));
    const organization = (await store.createOrganization({ name: 'Guarded', ownerUserId: 'owner' }));
    const project = (await store.createProject('Product', {}, organization.id));
    const first = (await createTask(store, project.id, 'First'));
    const second = (await createTask(store, project.id, 'Second'));

    await expect((async () => (await store.admitAgentUsage({ id: 'turn-1', organizationId: organization.id, projectId: project.id,
      taskId: first.id, provider: 'openai', model: 'gpt-approved', fundingSource: 'managed', now: 1_000_000 })))()).rejects.toThrow(/disabled until an organization owner sets a spend cap/);
    (await store.setOrganizationUsagePolicy(organization.id, { managedSpendCapMicros: 1_000_000,
      managedModelProviders: ['openai'], allowedModelProviders: ['openai'], allowedModels: ['gpt-approved'],
      maxAgentStartsPerMinute: 2, maxActiveAgentTurns: 1 }));
    await expect((async () => (await store.admitAgentUsage({ id: 'wrong-model', organizationId: organization.id, projectId: project.id,
      taskId: first.id, provider: 'openai', model: 'gpt-other', fundingSource: 'byok', now: 1_000_000 })))()).rejects.toThrow(/not allowed/);
    await expect((async () => (await store.admitAgentUsage({ id: 'unbounded-managed', organizationId: organization.id, projectId: project.id,
      taskId: first.id, provider: 'openai', model: 'gpt-approved', fundingSource: 'managed', now: 1_000_000 })))()).rejects.toThrow(/no installation-configured per-request cost ceiling/);
    expect((await store.admitAgentUsage({ id: 'turn-1', organizationId: organization.id, projectId: project.id,
      taskId: first.id, provider: 'openai', model: 'gpt-approved', fundingSource: 'managed',
      reservedCostMicros: 250_000, now: 1_000_000 })))
      .toEqual({ reused: false });
    expect((await store.admitAgentUsage({ id: 'turn-1', organizationId: organization.id, projectId: project.id,
      taskId: first.id, provider: 'openai', model: 'gpt-approved', fundingSource: 'managed',
      reservedCostMicros: 250_000, now: 1_000_001 })))
      .toEqual({ reused: true });
    await expect((async () => (await store.admitAgentUsage({ id: 'turn-2', organizationId: organization.id, projectId: project.id,
      taskId: second.id, provider: 'openai', model: 'gpt-approved', fundingSource: 'byok', now: 1_000_002 })))()).rejects.toThrow(/active model turn limit/);

    (await store.recordUsage({ id: 'usage:turn-1', organizationId: organization.id, projectId: project.id, taskId: first.id,
      provider: 'openai', kind: 'agent.cost', quantity: 0, unit: 'request', costMicros: 1_000_000,
      fundingSource: 'managed', costClassification: 'incurred', startedAt: 1_000_000, endedAt: 1_000_000 }));
    (await store.finishUsageAdmission('turn-1', true, 1_000_010));
    await expect((async () => (await store.admitAgentUsage({ id: 'turn-1', organizationId: organization.id, projectId: project.id,
      taskId: first.id, provider: 'openai', model: 'gpt-approved', fundingSource: 'managed',
      reservedCostMicros: 250_000, now: 1_000_011 })))()).rejects.toThrow(/spend cap is exhausted|already completed/);
    expect((await store.admitAgentUsage({ id: 'turn-2', organizationId: organization.id, projectId: project.id,
      taskId: second.id, provider: 'openai', model: 'gpt-approved', fundingSource: 'byok', now: 1_000_012 })))
      .toEqual({ reused: false });
    await expect((async () => (await store.admitAgentUsage({ id: 'turn-3', organizationId: organization.id, projectId: project.id,
      taskId: first.id, provider: 'openai', model: 'gpt-approved', fundingSource: 'byok', now: 1_000_013 })))()).rejects.toThrow(/rate limit/);

    expect((await store.usageSummary(organization.id, 0, 2_000_000))).toMatchObject({
      costMicros: 1_000_000, byFundingSource: { managed: 1_000_000 },
      incurredCostMicros: 1_000_000, estimatedCostMicros: 0,
      byProvider: { openai: 1_000_000 }, active: { agentTurns: 1 },
    });
  });

  it('keeps reservations separate, releases failures, and makes retries and completion idempotent', async () => {
    const store = (await Store.create(':memory:'));
    const organization = (await store.createOrganization({ name: 'Retry safe', ownerUserId: 'owner' }));
    const project = (await store.createProject('Product', {}, organization.id));
    const task = (await createTask(store, project.id, 'Retry'));
    (await store.setOrganizationUsagePolicy(organization.id, { managedSpendCapMicros: 250_000,
      managedModelProviders: ['openai'] }));
    const admission = { id: 'stable-turn', organizationId: organization.id, projectId: project.id,
      taskId: task.id, provider: 'openai', model: 'gpt-test', fundingSource: 'managed' as const,
      reservedCostMicros: 250_000, now: 1_000_000 };
    expect((await store.admitAgentUsage(admission))).toEqual({ reused: false });
    (await store.recordUsage({ id: 'usage:request:stable-turn', organizationId: organization.id, projectId: project.id,
      taskId: task.id, provider: 'openai', kind: 'agent.request', quantity: 1, unit: 'request',
      costMicros: 0, fundingSource: 'managed', costClassification: 'none', startedAt: 1_000_000, endedAt: 1_000_000 }));
    expect((await store.usageSummary(organization.id, 0, 2_000_000))).toMatchObject({
      costMicros: 0, activeReservationsMicros: 250_000, events: 1,
    });
    const concurrent = (await createTask(store, project.id, 'Concurrent reservation'));
    await expect((async () => (await store.admitAgentUsage({ ...admission, id: 'concurrent-turn', taskId: concurrent.id,
      now: 1_000_001 })))()).rejects.toThrow(/managed spend cap is exhausted/);
    (await store.finishUsageAdmission(admission.id, false, 1_000_001));
    expect((await store.usageSummary(organization.id, 0, 2_000_000))).toMatchObject({
      costMicros: 0, activeReservationsMicros: 0, events: 1,
    });
    expect((await store.admitAgentUsage({ ...admission, now: 1_000_002 }))).toEqual({ reused: true });
    expect((await store.admitAgentUsage({ ...admission, now: 1_000_003 }))).toEqual({ reused: true });
    (await store.finishUsageAdmission(admission.id, true, 1_000_004, [{ id: 'usage:cost:stable-turn',
      organizationId: organization.id, projectId: project.id, taskId: task.id, provider: 'openai',
      kind: 'agent.cost', quantity: 0, unit: 'request', costMicros: 250_000,
      fundingSource: 'managed', costClassification: 'estimated', startedAt: 1_000_004, endedAt: 1_000_004,
      metadata: { costBasis: 'admission-ceiling-estimate' } }]));
    await expect((async () => (await store.admitAgentUsage({ ...admission, now: 1_000_005 })))()).rejects.toThrow(/already completed/);
    const next = (await createTask(store, project.id, 'After estimate'));
    await expect((async () => (await store.admitAgentUsage({ ...admission, id: 'next-turn', taskId: next.id, now: 1_000_006 })))()).rejects.toThrow(/managed spend cap is exhausted/);
    expect((await store.usageSummary(organization.id, 0, 2_000_000))).toMatchObject({
      costMicros: 250_000, incurredCostMicros: 0, estimatedCostMicros: 250_000,
      activeReservationsMicros: 0, events: 2, requests: { total: 1, managed: 1 }, active: { agentTurns: 0 },
    });
  });

  it('keeps hosted remote execution BYOK by default and refuses centrally funded pools', async () => {
    const previous = process.env.KARMAX_DEPLOYMENT;
    delete process.env.KARMAX_DEPLOYMENT;
    try {
      const store = (await Store.create(':memory:', { hosted: true }));
      const organization = (await store.createOrganization({ name: 'BYOK', ownerUserId: 'owner' }));
      const project = (await store.createProject('Cloud', { worldProvider: 'e2b' }, organization.id));
      const task = (await createTask(store, project.id, 'Run'));
      const runners = new RunnerPoolService(store);
      (await store.createRunnerPool({ id: `${organization.id}:managed-e2b`, organizationId: organization.id,
        name: 'Legacy managed E2B', provider: 'e2b', mode: 'managed',
        capacity: { activeWorlds: 1, cpu: 40, memoryMb: 81920, gpu: 0 }, enabled: true }));
      const pool = (await runners.ensureDefaultPool(project, 'e2b'));
      expect(pool).toMatchObject({ mode: 'customer', provider: 'e2b', name: 'E2B · organization BYOK' });
      (await store.setOrganizationUsagePolicy(organization.id, { maxRemoteStartsPerMinute: 1, maxActiveAgentTurns: 1 }));
      const lease = await runners.acquire({ project, taskId: task.id, worldId: task.id, provider: 'e2b' });
      const queuedTask = (await createTask(store, project.id, 'Queued'));
      const queued = (await store.requestWorldLease({ runnerPoolId: pool.id, organizationId: organization.id,
        projectId: project.id, taskId: queuedTask.id, worldId: queuedTask.id }));
      expect(queued.acquired).toBe(false);
      (await runners.release(lease.leaseId, 'e2b'));
      expect((await store.worldLease(queued.id)).state).toBe('queued');

      (await store.createRunnerPool({ id: 'resold-e2b', organizationId: organization.id, name: 'Resold', provider: 'e2b',
        mode: 'managed', capacity: { activeWorlds: 1, cpu: 2, memoryMb: 2048, gpu: 0 }, enabled: true }));
      const blocked = (await store.createProject('Blocked', { worldProvider: 'e2b', runnerPoolId: 'resold-e2b' }, organization.id));
      const blockedTask = (await createTask(store, blocked.id, 'Blocked'));
      await expect(runners.acquire({ project: blocked, taskId: blockedTask.id, worldId: blockedTask.id, provider: 'e2b' }))
        .rejects.toThrow(/centrally funded remote sandbox pools are not enabled/);
    } finally {
      if (previous === undefined) delete process.env.KARMAX_DEPLOYMENT;
      else process.env.KARMAX_DEPLOYMENT = previous;
    }
  });

  it('uses hosted plan concurrency as BYOK world capacity and admits queued setup on upgrade', async () => {
    const store = (await Store.create(':memory:', { hosted: true }));
    const organization = (await store.createOrganization({ name: 'Plan worlds', ownerUserId: 'owner' }));
    const project = (await store.createProject('Cloud', { worldProvider: 'e2b' }, organization.id));
    (await store.createRunnerPool({ id: 'customer-e2b', organizationId: organization.id, name: 'Customer E2B', provider: 'e2b',
      mode: 'customer', capacity: { activeWorlds: 20, cpu: 1, memoryMb: 128, gpu: 0 }, enabled: true }));
    const lease = async (title: string) => {
      const task = (await createTask(store, project.id, title));
      return (await store.requestWorldLease({ runnerPoolId: 'customer-e2b', organizationId: organization.id,
        projectId: project.id, taskId: task.id, worldId: task.id, cpu: 8, memoryMb: 16_384, gpu: 1 }));
    };

    const freeActive = (await __asyncCollections.from({ length: 5 }, async (_, index) => (await lease(`Free active ${index + 1}`))));
    const freeQueued = (await lease('Free queued'));
    expect(freeActive.every((candidate) => candidate.acquired)).toBe(true);
    expect(freeQueued.acquired).toBe(false);

    (await store.setOrganizationPlan(organization.id, 'individual'));
    expect((await store.getRunnerPool('customer-e2b'))?.capacity.activeWorlds).toBe(10);
    expect((await store.worldLease(freeQueued.id)).state).toBe('active');
    const individualActive = (await __asyncCollections.from({ length: 4 }, async (_, index) => (await lease(`Individual active ${index + 7}`))));
    const overflow = (await lease('Individual queued'));
    expect(individualActive.every((candidate) => candidate.acquired)).toBe(true);
    expect(overflow.acquired).toBe(false);

    // A downgrade does not destroy running customer sandboxes. The queued world
    // stays queued until enough existing work parks or finishes.
    (await store.setOrganizationPlan(organization.id, 'free'));
    expect((await store.getRunnerPool('customer-e2b'))?.capacity.activeWorlds).toBe(5);
    expect((await store.worldLease(overflow.id)).state).toBe('queued');
    for (const active of freeActive) (await store.releaseWorldLease(active.id));
    expect((await store.worldLease(overflow.id)).state).toBe('queued');
    (await store.releaseWorldLease(freeQueued.id));
    expect((await store.worldLease(overflow.id)).state).toBe('active');
  });

  it('adds five hosted Team world slots when an additional user joins', async () => {
    const store = (await Store.create(':memory:', { hosted: true }));
    const organization = (await store.createOrganization({ name: 'Growing Team', ownerUserId: 'owner' }));
    (await store.setOrganizationPlan(organization.id, 'team'));
    const project = (await store.createProject('Cloud', { worldProvider: 'e2b' }, organization.id));
    (await store.createRunnerPool({ id: 'team-e2b', organizationId: organization.id, name: 'Team E2B', provider: 'e2b',
      mode: 'customer', capacity: { activeWorlds: 20, cpu: 1, memoryMb: 128, gpu: 0 }, enabled: true }));
    const lease = async (index: number) => {
      const task = (await createTask(store, project.id, `World ${index}`));
      return (await store.requestWorldLease({ runnerPoolId: 'team-e2b', organizationId: organization.id,
        projectId: project.id, taskId: task.id, worldId: task.id }));
    };

    const initial = (await __asyncCollections.from({ length: 21 }, async (_, index) => (await lease(index))));
    expect(initial.slice(0, 20).every((candidate) => candidate.acquired)).toBe(true);
    expect(initial[20]!.acquired).toBe(false);

    (await store.setOrganizationMembership(organization.id, 'second', 'member'));
    expect((await store.organizationEntitlements(organization.id)).maxActiveAgentRuns).toBe(25);
    expect((await store.getRunnerPool('team-e2b'))?.capacity.activeWorlds).toBe(25);
    expect((await store.worldLease(initial[20]!.id)).state).toBe('active');
  });

  it('accounts non-workflow access and reparks a remote world when the last accessor leaves', async () => {
    const store = (await Store.create(':memory:'));
    const organization = (await store.createOrganization({ name: 'Access', ownerUserId: 'owner' }));
    const project = (await store.createProject('Cloud', { worldProvider: 'e2b' }, organization.id));
    const task = (await store.createTask({ projectId: project.id, title: 'Inspect', workflow: 'just-do',
      workflowVersion: '1.0.0', params: { prompt: 'x' } as any }));
    const handle = (await store.registerWorld({ version: 2, kind: 'e2b', provider: 'e2b', id: task.id, generation: 1,
      root: '/workspace', workspaceRoot: '/workspace', branch: `karmax/${task.id}`, base: 'main',
      meta: { projectId: project.id } }, project.id)) as any;
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
    expect((await store.activeWorldLeaseCount(task.id))).toBe(1);
    const borrowed = await accessService.open(task.id, handle);
    expect(borrowed.runnerLeaseId).toBeUndefined();
    await access.release();
    expect((await store.activeWorldLeaseCount(task.id))).toBe(0);
    expect(parked).toBe(0);
    await borrowed.release();
    expect(parked).toBe(1);
    expect((await store.worldState(task.id))).toBe('parked');
  });

  it('hibernates parked worlds only after a portable checkpoint exists', async () => {
    const store = (await Store.create(':memory:'));
    const project = (await store.createProject('Lifecycle', { hibernateAfterMs: 0 }));
    const worlds = new WorldRegistry();
    const world = await worlds.create('memory', { taskId: 'world-1', base: 'main' });
    world.handle.meta = { projectId: project.id };
    world.handle = (await store.registerWorld(world.handle, project.id)) as typeof world.handle;
    (await store.saveWorldCheckpoint({ id: 'checkpoint-1', worldId: world.handle.id, generation: 1, projectId: project.id,
      runnerPoolId: 'local', environmentDigest: 'test', repos: [], createdAt: Date.now() }));
    (await store.setWorldState(world.handle, 'parked'));
    const lifecycle = new WorldLifecycleManager(store, worlds, {} as any, 1_000);
    expect(await lifecycle.sweep(Date.now() + 1)).toBe(1);
    expect((await store.worldState(world.handle.id))).toBe('hibernated');
  });

  it('marks an active world degraded when the provider reports its sandbox missing', async () => {
    const store = (await Store.create(':memory:'));
    const project = (await store.createProject('Reconcile', {}));
    const worlds = new WorldRegistry();
    // Replace the built-in provider with one whose control plane lost the sandbox.
    worlds.register({ kind: 'e2b', parkable: true, async probe() { return 'missing'; } } as any);
    const handle = (await store.registerWorld({ version: 2, kind: 'e2b', provider: 'e2b', id: 'task-reconcile', generation: 1,
      root: '/w', workspaceRoot: '/w', branch: 'karmax/task-reconcile', base: 'main', meta: {} }, project.id));
    expect(handle.generation).toBe(1);
    const lifecycle = new WorldLifecycleManager(store, worlds, {} as any, 1_000);
    await lifecycle.sweep(Date.now() + 60 * 60_000);
    expect((await store.worldState('task-reconcile'))).toBe('degraded');
  });

  it('leaves ready worlds alone when the provider has no probe or cannot say', async () => {
    const store = (await Store.create(':memory:'));
    const project = (await store.createProject('Local', {}));
    const worlds = new WorldRegistry();
    worlds.register({ kind: 'e2b', parkable: true, async probe() { return undefined; } } as any);
    (await store.registerWorld({ version: 2, kind: 'e2b', provider: 'e2b', id: 'task-unknown', generation: 1,
      root: '/w', workspaceRoot: '/w', branch: 'karmax/task-unknown', base: 'main', meta: {} }, project.id));
    (await store.registerWorld({ version: 2, kind: 'memory', provider: 'memory', id: 'task-local', generation: 1,
      root: '/w', workspaceRoot: '/w', branch: 'karmax/task-local', base: 'main', meta: {} }, project.id));
    const lifecycle = new WorldLifecycleManager(store, worlds, {} as any, 1_000);
    await lifecycle.sweep(Date.now() + 60 * 60_000);
    expect((await store.worldState('task-unknown'))).toBe('ready');
    expect((await store.worldState('task-local'))).toBe('ready');
  });

  /**
   * Daytona is created with `autoDeleteInterval: -1`, which switches the
   * provider's own reaper OFF on the explicit promise that karmax reaps
   * instead. That promise had no implementation — `listSandboxes` was written
   * on both providers and never called — so a sandbox whose task was deleted
   * before `destroyWorld` ran billed forever with nothing collecting it.
   */
  it('reaps a remote sandbox whose task is gone, and never one it cannot attribute', async () => {
    const store = (await Store.create(':memory:'));
    const project = (await store.createProject('Orphans', {}));
    const live = (await store.createTask({ projectId: project.id, title: 'Live', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'x' } as any }));
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
    const fullRead = vi.spyOn(store, 'getTask').mockImplementation(() => { throw Error('reaper loaded history'); });
    await lifecycle.sweep(Date.now());
    expect(fullRead).not.toHaveBeenCalled();
    fullRead.mockRestore();

    expect(destroyed).toEqual(['sb-orphan']);
    expect((await store.auditSince(0)).some((e: { action: string }) => e.action === 'world.orphanReaped')).toBe(true);
  });

  it('reaps duplicate provider allocations after one sandbox is durably registered', async () => {
    const store = (await Store.create(':memory:'));
    const project = (await store.createProject('Duplicate recovery', {}));
    const task = (await store.createTask({ projectId: project.id, title: 'Live', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'x' } as any }));
    const handle = (await store.registerWorld({ version: 2, kind: 'e2b', provider: 'e2b', id: task.id, generation: 1,
      root: '/w', workspaceRoot: '/w', branch: `karmax/${task.id}`, base: 'main', sealedProviderRef: 'sealed-current',
      meta: {} }, project.id));
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
    expect((await store.auditSince(0)).find((event: any) => event.detail?.sandboxId === 'duplicate')?.detail)
      .toMatchObject({ reason: 'duplicate' });
  });

  it('keeps sweeping after one provider control plane fails', async () => {
    const store = (await Store.create(':memory:'));
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
    const store = (await Store.create(':memory:'));
    const first = (await store.createOrganization({ name: 'First tenant', ownerUserId: 'owner-1' }));
    const second = (await store.createOrganization({ name: 'Second tenant', ownerUserId: 'owner-2' }));
    for (const organization of [first, second]) (await store.upsertWorldProviderConnection({
      organizationId: organization.id, provider: 'e2b', credentialHandle: `key:${organization.id}`, enabled: true,
    }));
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
    const store = (await Store.create(':memory:'));
    const organization = (await store.createOrganization({ name: 'Recovery', ownerUserId: 'owner' }));
    const project = (await store.createProject('Cloud', { worldProvider: 'e2b' }, organization.id));
    const task = (await createTask(store, project.id, 'Recover'));
    const runners = new RunnerPoolService(store);
    const lease = await runners.acquire({ project, taskId: task.id, worldId: task.id, provider: 'e2b' });
    (await store.registerWorld({ version: 2, kind: 'e2b', provider: 'e2b', id: task.id, generation: 1,
      root: '/workspace', workspaceRoot: '/workspace', branch: `karmax/${task.id}`, base: 'main', meta: {} }, project.id));
    (await store.createExecution({ id: 'execution-1', organizationId: organization.id, projectId: project.id,
      taskId: task.id, worldId: task.id, generation: 1, kind: 'terminal', label: 'Terminal',
      server: false, openUrls: [], runnerLeaseId: lease.leaseId, state: 'running', heartbeatAt: 1, startedAt: 1 }));
    const lifecycle = new WorldLifecycleManager(store, new WorldRegistry(), {} as any, 1_000, undefined, runners);
    await lifecycle.sweep(3 * 60_000);
    expect((await store.execution('execution-1'))?.state).toBe('lost');
    expect((await store.worldLease(lease.leaseId))?.state).toBe('released');
  });
});

async function createTask(store: Store, projectId: string, title: string) {
  return (await store.createTask({ projectId, title, workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: title } as any }));
}
