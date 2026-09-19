import { afterEach, describe, expect, it, vi } from 'vitest';
import { Context } from '@temporalio/activity';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';
import { WorldAccessService } from '../src/world/access.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { makeCoreActivities } from '../src/activities/core.js';
import { lifecyclePublication } from '../src/domain/view-publication.js';
import type { TaskView } from '../src/domain/types.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
const stores: Store[] = [];
afterEach(() => { vi.restoreAllMocks(); stores.splice(0).forEach(store => store.close()); });
function fixture(kind: 'memory' | 'e2b' = 'memory') {
  const store = new Store(':memory:'); stores.push(store);
  const project = store.createProject('Lifecycle');
  const task = store.createTask({ projectId: project.id, title: 'Wait', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'work' } });
  const handle = store.registerWorld({ id: task.id, kind, root: '/workspace', branch: 'task', base: 'main' }, project.id) as any;
  const worlds = new WorldRegistry();
  let parked = false;
  const open = vi.fn(async () => { parked = false; return { handle } as any; });
  const park = vi.fn(async () => { parked = true; return handle; });
  worlds.register({ kind, capabilities: { remote: kind === 'e2b' }, parkable: true, open, park,
    status: async () => parked ? 'parked' : 'ready' } as any);
  const checkpoint = vi.fn(async () => ({ id: 'checkpoint', generation: 1 }));
  const runners = { release: vi.fn((id: string) => store.releaseWorldLease(id)), acquire: vi.fn() };
  const core = makeCoreActivities({ store, worlds, runners: runners as any, adapters: new Map(), profiles: new ProfileResolver(store, 'mock'),
    checkpoints: { checkpoint } as any });
  const view = { taskId: task.id, title: task.title, workflow: task.workflow, stage: 'do', status: 'waiting',
    waitingFor: { kind: 'human', audience: ['@creator'] }, world: handle, state: {}, messages: [], actions: [], updatedAt: 1 } as TaskView;
  const publish = (next = view) => core.publishView(task.id, next, undefined, { separateLifecycle: true });
  return { store, project, task, handle, worlds, checkpoint, core, view, publish, open, park, runners, setParked: () => { parked = true; } };
}

describe('separate waiting-world maintenance', () => {
  it('persists status without checkpoint work, then runs checkpoint and park independently', async () => {
    const f = fixture();
    const fence = await f.publish();
    expect(f.store.taskMetadata(f.task.id)?.lastView?.status).toBe('waiting');
    expect(f.checkpoint).not.toHaveBeenCalled();
    expect(f.park).not.toHaveBeenCalled();
    await f.core.parkWaitingWorld(f.task.id, lifecyclePublication(f.view), fence!);
    expect(f.checkpoint).toHaveBeenCalledOnce();
    expect(f.park).toHaveBeenCalledOnce();
    expect(f.store.worldState(f.task.id)).toBe('parked');
  });

  it.each(['publication', 'status', 'generation', 'run', 'access'])('rejects an obsolete or busy world: %s', async change => {
    const f = fixture();
    const fence = await f.publish();
    let release: (() => void) | undefined;
    if (change === 'publication') await f.publish();
    if (change === 'status') f.store.saveView(f.task.id, { ...f.view, status: 'active' });
    if (change === 'generation') f.store.registerWorld({ ...f.handle, generation: 2 }, f.project.id);
    if (change === 'run') {
      f.store.updateTaskParams(f.task.id, { ...f.task.params, _workflowRunId: 'new-run' });
      vi.spyOn(Context, 'current').mockReturnValue({ heartbeat() {}, cancellationSignal: new AbortController().signal,
        info: { workflowExecution: { runId: 'old-run' } } } as any);
    }
    if (change === 'access') release = f.worlds.holdAccess(f.handle.id);
    try { await f.core.parkWaitingWorld(f.task.id, lifecyclePublication(f.view), fence!); }
    finally { release?.(); }
    expect(f.checkpoint).not.toHaveBeenCalled();
    expect(f.park).not.toHaveBeenCalled();
  });

  it('rechecks a publication changed while checkpointing', async () => {
    const f = fixture(), started = deferred(), finish = deferred();
    f.checkpoint.mockImplementation(async () => { started.resolve(); await finish.promise; return { id: 'checkpoint', generation: 1 }; });
    const fence = await f.publish();
    const maintenance = f.core.parkWaitingWorld(f.task.id, lifecyclePublication(f.view), fence!);
    await started.promise;
    await f.publish({ ...f.view, status: 'active', updatedAt: 2 });
    finish.resolve(); await maintenance;
    expect(f.park).not.toHaveBeenCalled();
  });

  it('opens after a park already in flight has finished, including resource preparation', async () => {
    const f = fixture(), started = deferred(), finish = deferred();
    f.park.mockImplementation(async () => { started.resolve(); await finish.promise; f.setParked(); return f.handle; });
    const fence = await f.publish();
    const maintenance = f.core.parkWaitingWorld(f.task.id, lifecyclePublication(f.view), fence!);
    await started.promise;
    const prepare = vi.fn(async world => world);
    const access = new WorldAccessService(f.store, f.worlds, undefined, { prepare } as any);
    const opening = access.open(f.task.id, f.handle);
    await new Promise(resolve => setImmediate(resolve));
    expect(f.open).not.toHaveBeenCalled();
    finish.resolve(); await maintenance;
    const opened = await opening;
    expect(f.open).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledOnce();
    await opened.release(false);
    expect(f.worlds.activeAccessCount(f.handle.id)).toBe(0);
  });

  it('lets an existing accessor release capacity while another waits for admission', async () => {
    const f = fixture(), waiting = deferred(), capacity = deferred();
    f.worlds.register({ ...f.worlds.get('memory'), capabilities: { remote: true } } as any);
    let count = 0;
    const runners = { acquire: vi.fn(async () => {
      if (++count === 2) { waiting.resolve(); await capacity.promise; }
      return { leaseId: `lease-${count}`, runnerPoolId: 'test' };
    }), release: vi.fn(() => { capacity.resolve(); }) };
    const access = new WorldAccessService(f.store, f.worlds, runners as any);
    const first = await access.open(f.task.id, f.handle, { dedicated: true });
    const pending = access.open(f.task.id, f.handle, { dedicated: true });
    await waiting.promise;
    await first.release();
    const second = await pending;
    expect(f.park).not.toHaveBeenCalled();
    await second.release(false);
    expect(f.worlds.activeAccessCount(f.handle.id)).toBe(0);
  });

  it('heartbeats while queued and honors cancellation before touching the provider', async () => {
    const f = fixture(), entered = deferred(), finish = deferred();
    const holding = f.worlds.withOperation(f.handle.id, async () => { entered.resolve(); await finish.promise; });
    await entered.promise;
    const cancellation = new AbortController();
    const heartbeat = vi.fn();
    vi.spyOn(Context, 'current').mockReturnValue({ heartbeat, cancellationSignal: cancellation.signal,
      info: { workflowExecution: { runId: 'run' } } } as any);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const fence = await f.publish();
      const maintenance = f.core.parkWaitingWorld(f.task.id, lifecyclePublication(f.view), fence!);
      const rejected = expect(maintenance).rejects.toThrow('cancelled');
      await vi.advanceTimersByTimeAsync(15_000);
      expect(heartbeat).toHaveBeenCalledTimes(4);
      cancellation.abort(new Error('cancelled'));
      finish.resolve(); await holding; await rejected;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(heartbeat).toHaveBeenCalledTimes(4);
      expect(f.park).not.toHaveBeenCalled();
    } finally { finish.resolve(); vi.useRealTimers(); }
  });

  it('finishes lease cleanup after a crash that left the provider parked', async () => {
    const f = fixture();
    f.store.createRunnerPool({ id: 'test', organizationId: f.project.organizationId!, name: 'Test', provider: 'memory',
      mode: 'customer', capacity: { activeWorlds: 1, cpu: 2, memoryMb: 2048, gpu: 0 }, enabled: true });
    const lease = f.store.requestWorldLease({ runnerPoolId: 'test', organizationId: f.project.organizationId!,
      projectId: f.project.id, taskId: f.task.id, worldId: f.handle.id });
    f.store.updateWorldMeta(f.handle, { worldLeaseId: lease.id });
    const fence = await f.publish();
    f.runners.release.mockImplementationOnce(() => { throw new Error('worker interrupted'); });
    await expect(f.core.parkWaitingWorld(f.task.id, lifecyclePublication(f.view), fence!)).rejects.toThrow('worker interrupted');
    expect(f.store.worldLease(lease.id).state).toBe('active');
    await f.core.parkWaitingWorld(f.task.id, lifecyclePublication(f.view), fence!);
    expect(f.store.worldLease(lease.id).state).toBe('released');
    expect(f.store.currentWorld(f.handle.id)?.meta?.worldLeaseId).toBeNull();
    expect(f.park).toHaveBeenCalledOnce();
    expect(f.checkpoint).toHaveBeenCalledOnce();
  });

  it('reacquires transient admission when a park releases the lease it intended to borrow', async () => {
    const f = fixture(), started = deferred(), finish = deferred();
    f.worlds.register({ ...f.worlds.get('memory'), capabilities: { remote: true } } as any);
    f.store.createRunnerPool({ id: 'test', organizationId: f.project.organizationId!, name: 'Test', provider: 'memory',
      mode: 'customer', capacity: { activeWorlds: 1, cpu: 2, memoryMb: 2048, gpu: 0 }, enabled: true });
    const acquire = () => f.store.requestWorldLease({ runnerPoolId: 'test', organizationId: f.project.organizationId!,
      projectId: f.project.id, taskId: f.task.id, worldId: f.handle.id });
    const lease = acquire();
    f.store.updateWorldMeta(f.handle, { worldLeaseId: lease.id });
    f.runners.acquire.mockImplementation(async () => ({ leaseId: acquire().id, runnerPoolId: 'test' }));
    const fence = await f.publish();
    f.park.mockImplementation(async () => { started.resolve(); await finish.promise; f.setParked(); return f.handle; });
    const maintenance = f.core.parkWaitingWorld(f.task.id, lifecyclePublication(f.view), fence!);
    await started.promise;
    // The checkpoint has already opened the provider; count only new access.
    f.open.mockClear();
    const service = new WorldAccessService(f.store, f.worlds, f.runners as any);
    const opening = service.open(f.task.id, f.handle);
    await new Promise(resolve => setImmediate(resolve));
    expect(f.open).not.toHaveBeenCalled();
    finish.resolve(); await maintenance;
    const access = await opening;
    expect(access.runnerLeaseId).toBeDefined();
    expect(access.runnerLeaseId).not.toBe(lease.id);
    expect(f.store.worldLease(access.runnerLeaseId!).state).toBe('active');
    expect(f.runners.acquire).toHaveBeenCalledOnce();
    await access.release(false);
    expect(f.store.activeWorldLeaseCount(f.handle.id)).toBe(0);
  });

  it('reacquires a workflow lease released by a park already in flight before opening', async () => {
    const f = fixture('e2b'), started = deferred(), finish = deferred();
    f.store.createRunnerPool({ id: 'test', organizationId: f.project.organizationId!, name: 'Test', provider: 'e2b',
      mode: 'customer', capacity: { activeWorlds: 1, cpu: 2, memoryMb: 2048, gpu: 0 }, enabled: true });
    const acquire = () => f.store.requestWorldLease({ runnerPoolId: 'test', organizationId: f.project.organizationId!,
      projectId: f.project.id, taskId: f.task.id, worldId: f.handle.id });
    const lease = acquire();
    f.store.updateWorldMeta(f.handle, { worldLeaseId: lease.id });
    f.runners.acquire.mockImplementation(async () => ({ leaseId: acquire().id, runnerPoolId: 'test' }));
    const ctx = { heartbeat() {}, cancellationSignal: new AbortController().signal,
      info: { attempt: 1, workflowExecution: { runId: 'run', workflowId: f.task.id }, activityId: 'turn',
        currentAttemptScheduledTimestampMs: Date.now() } };
    vi.spyOn(Context, 'current').mockReturnValue(ctx as any);
    // No checkpoint in this fixture: exercise the park/open transition itself.
    const core = makeCoreActivities({ store: f.store, worlds: f.worlds, runners: f.runners as any,
      adapters: new Map(), profiles: new ProfileResolver(f.store, 'mock') });
    const fence = await core.publishView(f.task.id, f.view, undefined, { separateLifecycle: true });
    f.park.mockImplementation(async () => { started.resolve(); await finish.promise; f.setParked(); return f.handle; });
    const maintenance = core.parkWaitingWorld(f.task.id, lifecyclePublication(f.view), fence!);
    await started.promise;
    f.open.mockImplementation(async () => {
      const id = f.store.currentWorld(f.handle.id)?.meta?.worldLeaseId as string;
      expect(id).not.toBe(lease.id);
      expect(f.store.worldLease(id)?.state).toBe('active');
      throw new Error('verified metered open');
    });
    const turn = core.runAgentTurn({ taskId: f.task.id, role: 'do', agentTurnId: `${f.task.id}#1`, messages: [],
      worldHandle: f.handle, task: { taskId: f.task.id, projectId: f.project.id, title: f.task.title, prompt: 'work',
        project: {}, workflow: 'just-do', agents: { do: { provider: 'mock' } } } } as any);
    const rejected = expect(turn).rejects.toThrow('verified metered open');
    await new Promise(resolve => setImmediate(resolve));
    expect(f.open).not.toHaveBeenCalled();
    finish.resolve(); await maintenance; await rejected;
    expect(f.runners.acquire).toHaveBeenCalledOnce();
    expect(f.open).toHaveBeenCalledOnce();
  });

  it('propagates maintenance failure without repeating the authoritative publication', async () => {
    const f = fixture();
    const fence = await f.publish();
    f.park.mockRejectedValueOnce(new Error('provider unavailable'));
    await expect(f.core.parkWaitingWorld(f.task.id, lifecyclePublication(f.view), fence!)).rejects.toThrow('provider unavailable');
    await f.core.parkWaitingWorld(f.task.id, lifecyclePublication(f.view), fence!);
    expect(f.store.eventsSince(f.task.id, 0).filter(e => e.type === 'view.updated')).toHaveLength(1);
    expect(f.store.worldState(f.task.id)).toBe('parked');
  });
});
