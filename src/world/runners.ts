import { checkpointStale } from './checkpoint-staleness.js';
import * as __asyncCollections from '../util/async-collections.js';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { Store } from '../store/db.js';
import type { Project, RunnerPool, WorldHandleRef } from '../domain/types.js';
import type { ProviderSandboxRef, WorldHandle } from './types.js';
import { ANY_PROVIDER, describeMachine, isAnyProvider, machineShape, sameMachine, type MachineShape } from '../domain/computer.js';
import { assertComputerFits, type ComputerLimits } from '../domain/computer-limits.js';
import type { WorldRegistry } from './registry.js';
import type { WorldCheckpointService } from './checkpoint.js';
import type { ObjectStore } from '../store/objects.js';
import { expireConversationExports } from '../store/conversation-exports.js';
import { DeferredDeleteObjectStore } from '../store/deferred-delete.js';
import { taskEnded } from './task-ended.js';
import { taskProvider } from './task-provider.js';
import { assertComputeCredit, assertManagedRoom } from './managed-compute.js';
import { MANAGED_COMPUTE, worldAccountLimits } from './connections.js';

const fits = (shape: MachineShape, limits: ComputerLimits): boolean => {
  try { assertComputerFits(shape, limits, ''); return true; } catch { return false; }
};

/** What the runner service needs to know about managed compute
 * (WorldProviderConnectionService). */
export interface ManagedComputeAccounts {
  funding(organizationId: string | undefined, provider: string): Promise<'managed' | 'own' | undefined>;
  managedConnections(): Promise<Array<{ provider: string; config: { share?: number }; limits: { pool?: { cpu?: number; machines?: number } } }>>;
}

// Private/explicit pools retain physical resource totals. Hosted customer-owned
// pools ignore these totals and derive active worlds from plan concurrency.
const DEFAULT_CAPACITY = { activeWorlds: 20, cpu: 40, memoryMb: 81_920, gpu: 0 };
const STALE_PARKED_LEASE_MS = 2 * 60_000;
/** Providers whose own control plane reports billable time (`listUsageEvents`):
 * a runner lease there only reserves capacity, and billing it too would charge twice. */
const PROVIDER_METERED = new Set(['e2b', 'fly', 'hetzner', 'aws', 'gcp']);

/** Durable admission and cost attribution for execution-plane capacity. The DB
 * queue is the source of truth, so a waiting activity can restart on any worker. */
export class RunnerPoolService {
  constructor(private store: Store, private managed?: ManagedComputeAccounts) {}

  async ensureDefaultPool(project: Project, provider: string): Promise<RunnerPool> {
    const organizationId = project.organizationId!;
    const requested = (await this.store.effectiveProjectConfig(project)).runnerPoolId;
    if (requested) {
      const pool = (await this.store.getRunnerPool(requested));
      if (!pool || pool.organizationId !== organizationId || !pool.enabled) throw new Error('configured runner pool is unavailable');
      if (pool.provider !== provider) throw new Error(`configured runner pool uses ${pool.provider}, not ${provider}`);
      return pool;
    }
    const remote = !['worktree', 'container', 'memory'].includes(provider);
    const hostedActiveWorlds = remote && this.store.hosted
      ? (await this.store.getOrganizationUsagePolicy(organizationId)).maxActiveWorlds
      : undefined;
    // Managed compute (the installation's account) has a pool of its own, so
    // its leases are told apart from the organization's own account's: they
    // count toward the installation's concurrency and bill as managed.
    if (remote && await this.managed?.funding(organizationId, provider) === 'managed') {
      const managedId = `${organizationId}:tavya-${provider}`;
      const pool = await this.store.getRunnerPool(managedId);
      const capacity = { ...DEFAULT_CAPACITY, ...(hostedActiveWorlds == null ? {} : { activeWorlds: hostedActiveWorlds }) };
      if (pool && pool.capacity.activeWorlds === capacity.activeWorlds) return pool;
      return this.store.createRunnerPool({ ...pool, id: managedId, organizationId, name: `${provider.toUpperCase()} · managed`,
        provider, mode: 'managed', capacity, enabled: true });
    }
    const id = `${organizationId}:${remote ? `managed-${provider}` : 'local'}`;
    const existing = (await this.store.getRunnerPool(id));
    if (existing) {
      // Older releases named the default remote pool "managed" even though the
      // launch rail is now strictly organization BYOK. The provider connection
      // boundary separately fails closed when that organization has no key.
      if (remote && this.store.hosted && (existing.mode === 'managed'
        || existing.capacity.activeWorlds !== hostedActiveWorlds))
        return (await this.store.createRunnerPool({ ...existing, name: `${provider.toUpperCase()} · organization BYOK`, mode: 'customer',
          capacity: { ...existing.capacity, activeWorlds: hostedActiveWorlds! } }));
      return existing;
    }
    return (await this.store.createRunnerPool({ id, organizationId,
      name: remote ? `${provider.toUpperCase()} · organization BYOK` : 'Local runner', provider,
      // Remote launch credentials are organization-owned by default. Hosted
      // active-world capacity is the plan entitlement, not a second pool product.
      mode: 'customer', capacity: { ...DEFAULT_CAPACITY,
        ...(hostedActiveWorlds == null ? {} : { activeWorlds: hostedActiveWorlds }) }, enabled: true }));
  }

  async acquire(input: { project: Project; taskId: string; worldId: string; provider: string; priority?: number;
    /** The task's own machine size, when its Computer differs from the project's. */
    resources?: Project['config']['resources'];
    /** New work (a task's first machine): refused once the organization's
     * managed compute credit is spent. Waking a world to save or publish its
     * work is not. */
    work?: boolean;
    heartbeat?: () => void; signal?: AbortSignal; pollMs?: number }): Promise<{ leaseId: string; runnerPoolId: string }> {
    if (input.signal?.aborted)
      throw input.signal.reason ?? new Error('runner lease cancelled');
    const projectConfig = (await this.store.effectiveProjectConfig(input.project));
    const config = input.resources ? { ...projectConfig, resources: input.resources } : projectConfig;
    const pool = (await this.ensureDefaultPool(input.project, input.provider));
    if (pool.mode === 'managed') {
      if (input.work) await assertComputeCredit(this.store, input.project.organizationId!, input.provider, Date.now(),
        { shape: config.resources, taskId: input.taskId });
      const account = (await this.managed?.managedConnections())?.find((value) => value.provider === input.provider);
      if (account) await assertManagedRoom(this.store, input.provider, { pool: account.limits.pool, share: account.config.share },
        input.project.organizationId!, config.resources?.cpu);
    }
    const month = monthWindow(Date.now());
    const organizationPolicy = (await this.store.getOrganizationExecutionPolicy(input.project.organizationId!));
    const organizationSpent = (await this.store.usageSummary(input.project.organizationId!, month.from, month.to)).costMicros;
    if (organizationPolicy.monthlyBudgetMicros != null && organizationSpent >= organizationPolicy.monthlyBudgetMicros)
      throw new Error('organization monthly cloud budget is exhausted');
    const projectSpent = (await this.store.usageSummary(input.project.organizationId!, month.from, month.to, input.project.id)).costMicros;
    if (input.project.config.monthlyBudgetMicros != null && projectSpent >= input.project.config.monthlyBudgetMicros)
      throw new Error('project monthly cloud budget is exhausted');
    const requested = (await this.store.requestWorldLease({ runnerPoolId: pool.id, organizationId: input.project.organizationId!,
      projectId: input.project.id, taskId: input.taskId, worldId: input.worldId,
      cpu: config.resources?.cpu, memoryMb: config.resources?.memoryMb,
      gpu: config.resources?.gpu, priority: input.priority }));
    try {
      for (;;) {
        const lease = (await this.store.worldLease(requested.id));
        if (!lease || lease.state === 'released')
          throw new Error('runner lease was released before admission');
        if (lease.acquiredAt) break;
        if (input.signal?.aborted)
          throw input.signal.reason ?? new Error('runner lease cancelled');
        // A heartbeat can throw when Temporal has already timed this activity
        // out. Treat that exactly like cancellation: the retry must not inherit
        // an invisible reservation from an activity that no longer exists.
        input.heartbeat?.();
        await new Promise((resolve) => setTimeout(resolve, Math.max(100, input.pollMs ?? 1_000)));
      }
      if (input.signal?.aborted)
        throw input.signal.reason ?? new Error('runner lease cancelled');
      return { leaseId: requested.id, runnerPoolId: pool.id };
    } catch (error) {
      // This reservation has not been published into the durable world handle,
      // so no other lifecycle owner can know to release it. Do not call the
      // billed release path: a failed admission wait never ran a sandbox.
      (await this.store.releaseWorldLease(requested.id));
      throw error;
    }
  }

  async release(leaseId: string, provider: string): Promise<void> {
    const lease = (await this.store.worldLease(leaseId));
    if (!lease || lease.state === 'released') return;
    const billedProvider = (await this.store.getRunnerPool(lease.runnerPoolId))?.provider ?? provider;
    const endedAt = Date.now();
    (await this.store.releaseWorldLease(leaseId));
    const startedAt = Number(lease.acquiredAt ?? lease.createdAt);
    const seconds = Math.max(0, (endedAt - startedAt) / 1000);
    // E2B runner leases reserve concurrency; they are not billing intervals.
    // Its sandboxes auto-pause independently and report exact executions through
    // lifecycle events, reconciled by WorldLifecycleManager below; Fly and
    // Hetzner report their machines' runs and volumes the same way.
    if (PROVIDER_METERED.has(billedProvider)) return;
    (await this.store.recordUsage({ id: `usage:${leaseId}`, organizationId: lease.organizationId, projectId: lease.projectId,
      taskId: lease.taskId, worldId: lease.worldId, provider: billedProvider, kind: 'world.active', quantity: seconds,
      unit: 'second', costMicros: Math.round(seconds * costMicrosPerSecond(billedProvider, lease.cpu, lease.memoryMb, lease.gpu)),
      startedAt, endedAt, fundingSource: (await this.store.getRunnerPool(lease.runnerPoolId))?.mode === 'managed' ? 'managed' : 'byok',
      metadata: { runnerPoolId: lease.runnerPoolId, cpu: lease.cpu, memoryMb: lease.memoryMb, gpu: lease.gpu } }));
  }

  /** Repair reservations whose activity owner disappeared before it could
   * publish or release them. Terminal tasks own no workflow capacity. Likewise,
   * a parked/hibernated/released world cannot own an old active reservation: a
   * genuine wake-up has a short grace period in which to mark the world ready.
   * And a running world's current generation names the one lease its setup
   * took: a lease taken before that generation existed, which it does not name
   * and nothing borrows, is a setup attempt that died with its worker (a
   * deploy). Left active it reads as another user of the world, which then
   * never parks, so never moves to a new size (pramana#39). */
  async reconcileWorldLeases(now = Date.now()): Promise<number> {
    let released = 0;
    for (const lease of (await this.store.unreleasedWorldLeases())) {
      const task = (await this.store.taskMetadata(String(lease.taskId)));
      const world = (await this.store.currentWorld(String(lease.worldId)));
      const snapshot = (await this.store.worldStateSnapshot(String(lease.worldId)));
      const passiveWorld = ['parked', 'hibernated', 'released'].includes(snapshot?.state ?? '');
      const terminal = !task || ['done', 'cancelled', 'failed'].includes(task.lastView?.status ?? 'active');
      const stale = Number(lease.acquiredAt ?? lease.createdAt) <= now - STALE_PARKED_LEASE_MS;
      const borrowed = (await this.store.worldLeaseHasLiveAccessor(String(lease.id), now));
      const terminalWorkflowLease = terminal
        && (!world || world.meta?.worldLeaseId === lease.id || (lease.state === 'active' && stale && !borrowed));
      const stalePassiveLease = lease.state === 'active'
        && passiveWorld
        && stale
        && !borrowed;
      const deadSetupLease = !!world && !!snapshot
        && world.meta?.worldLeaseId !== lease.id
        && Number(lease.createdAt) < snapshot.createdAt
        && stale
        && !borrowed;
      if (!terminalWorkflowLease && !stalePassiveLease && !deadSetupLease) continue;
      // Reconciliation fixes an internal reservation leak; it must not bill the
      // tenant for wall time in which the provider world was already parked.
      (await this.store.releaseWorldLease(String(lease.id)));
      released++;
    }
    return released;
  }
}

/** Turns old parked provider state into cheap object/Git state. */
export class WorldLifecycleManager {
  private timer?: NodeJS.Timeout;
  private sweeping?: Promise<number>;
  /** Last provider probe per world generation, so reconciliation does not hit
   * the provider control plane on every sweep tick. */
  private probedAt = new Map<string, number>();
  /** Failed hibernation attempts of one parked snapshot (generation and
   * updatedAt). Each attempt reopens, and so resumes and bills, the provider
   * sandbox, so a persistent failure must not repeat on every sweep (WD-2).
   * Touching the world starts a fresh idle period and so a fresh schedule. */
  private hibernateFailures = new Map<string, { generation: number; updatedAt: number; attempts: number; retryAt: number }>();
  constructor(private store: Store, private worlds: WorldRegistry, private checkpoints: WorldCheckpointService,
    private intervalMs = 60_000, private objects?: ObjectStore, private runners?: RunnerPoolService,
    private access?: import('./access.js').WorldAccessService) {}

  start(): void {
    if (this.timer) return;
    // Recover capacity during boot, before new setup activities spend another
    // poll interval queued behind stale state from the previous process.
    void this.sweep().catch(() => undefined);
    this.timer = setInterval(() => void this.sweep().catch(() => undefined), this.intervalMs);
    this.timer.unref();
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.sweeping?.catch(() => {});
  }

  sweep(now = Date.now()): Promise<number> {
    return this.sweeping ??= this.sweepOnce(now).finally(() => { this.sweeping = undefined; });
  }

  /** One step of a sweep, or one world within it, failing on its own: the
   * rest of the sweep still runs (pramana#3: one world whose operation lock
   * stayed held made every sweep throw before hibernating anything, for hours,
   * unseen). A failure is logged when it starts or changes, not every minute. */
  private async step(name: string, work: () => Promise<unknown>): Promise<void> {
    try {
      await work();
      this.failing.delete(name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.failing.get(name) !== message) console.warn(`[world lifecycle] ${name}: ${message}`);
      this.failing.set(name, message);
    }
  }
  private failing = new Map<string, string>();

  private async sweepOnce(now: number): Promise<number> {
    await this.step('runner leases', async () => this.runners?.reconcileWorldLeases(now));
    await this.step('checkpoint garbage', async () => this.checkpoints.collectGarbage?.());
    if (this.objects instanceof DeferredDeleteObjectStore) await this.objects.purgeDue(now).catch(() => undefined);
    await this.step('provider usage', () => this.reconcileProviderUsage(now));
    await this.step('promoted artifacts', async () => {
      for (const artifact of (await this.store.expiredPromotedArtifacts(now))) {
        (await this.store.deletePromotedArtifact(artifact.id));
        await this.objects?.delete(artifact.objectKey).catch(() => undefined);
      }
    });
    if (this.objects) await this.step('conversation exports', () => expireConversationExports(this.store, this.objects!, now));
    for (const preview of (await this.store.expiredPreviewLeases(now))) {
      await this.step(`preview ${preview.id}`, async () => {
        (await this.store.revokePreviewLease(preview.id));
        const handle = (await this.store.currentWorld(preview.worldId)) as any;
        if (handle && this.access) await this.access.releaseLeaseAndParkIfIdle(handle, preview.runnerLeaseId);
        else if (preview.runnerLeaseId) (await this.runners?.release(preview.runnerLeaseId, preview.provider));
      });
    }
    for (const id of (await this.store.markLostExecutions(now - 2 * 60_000))) {
      await this.step(`lost execution ${id}`, async () => {
        const execution = (await this.store.execution(id));
        if (!execution?.runnerLeaseId) return;
        const world = (await this.store.currentWorld(execution.worldId));
        if (world && this.access) await this.access.releaseLeaseAndParkIfIdle(world as any, execution.runnerLeaseId);
        else (await this.runners?.release(execution.runnerLeaseId, world?.provider ?? world?.kind ?? 'unknown'));
      });
    }
    // Reconciliation: an active remote world whose sandbox disappeared
    // out-of-band (manual deletion, provider eviction) should surface as
    // degraded now, not as an opaque failure on the task's next operation.
    // Local providers have no probe and are skipped.
    const reconcileAfter = reconcileAfterMs();
    if (reconcileAfter > 0) {
      for (const candidate of (await this.store.listWorldInstances('ready', now - reconcileAfter))) {
        const key = `${candidate.handle.id}:${candidate.handle.generation ?? 1}`;
        if ((this.probedAt.get(key) ?? 0) > now - reconcileAfter) continue;
        await this.step(`probe ${candidate.handle.id}`, () => this.worlds.withOperation(candidate.handle.id, async () => {
          const unchanged = async () => {
            const current = await this.store.worldStateSnapshot(candidate.handle.id);
            return current?.state === 'ready'
              && current.generation === (candidate.handle.generation ?? 1)
              && current.updatedAt === Number(candidate.updatedAt);
          };
          if (!(await unchanged())) return;
          this.probedAt.set(key, now);
          const state = await this.worlds.probe(candidate.handle as any).catch(() => undefined);
          // A VM the provider has stopped, that nothing holds or uses, is
          // parked whatever the store says: a wake that failed before its
          // undo existed left such worlds ready, so they never hibernated and
          // kept their volumes (pramana#60). An E2B pause keeps processes and
          // is left alone.
          if (state === 'parked' && this.worlds.get(candidate.handle.kind).parkStopsProcesses && (await unchanged())
            && !(await this.worlds.hasActiveAccess?.(candidate.handle.id))) {
            const leaseId = candidate.handle.meta?.worldLeaseId;
            if (typeof leaseId === 'string' && (await this.store.worldLease(leaseId))?.state === 'active') return;
            await this.store.setWorldState(candidate.handle, 'parked');
            await this.recordLifecycle(candidate.handle, 'world.parked', { reason: 'reconciled' });
            return;
          }
          if (state !== 'missing' || !(await unchanged())) return;
          await this.store.setWorldState(candidate.handle, 'degraded');
          await this.recordLifecycle(candidate.handle, 'world.providerLost', {});
        }));
      }
    }
    for (const candidate of await this.store.listWorldInstances('degraded')) {
      // A failed teardown is marked; a finished task's world revived and left
      // degraded (task #552) is not, and is torn down all the same.
      if (!candidate.handle.meta?.teardownPending && !(await taskEnded(this.store, candidate.handle.id))) continue;
      await this.step(`teardown ${candidate.handle.id}`, () => this.worlds.withOperation(candidate.handle.id, () => this.worlds.withoutRecovery(async () => {
        const eligible = async () => {
          const current = await this.store.worldStateSnapshot(candidate.handle.id);
          const task = await this.store.taskMetadata(candidate.handle.id);
          return current?.state === 'degraded' && current.generation === (candidate.handle.generation ?? 1)
            && (!task || ['done', 'failed', 'cancelled'].includes(task.lastView?.status ?? 'active'))
            && !(await this.worlds.hasActiveAccess(candidate.handle.id))
            && await this.store.activeWorldLeaseCount(candidate.handle.id) === 0;
        };
        if (!(await eligible())) return;
        try {
          const provider = this.worlds.get(candidate.handle.kind);
          if (provider.destroy) await provider.destroy(candidate.handle as any);
          else {
            const world = await this.worlds.open(candidate.handle as any);
            if (!(await eligible())) return;
            await world.destroy();
          }
        } catch {
          if (await this.worlds.probe(candidate.handle as any).catch(() => undefined) !== 'missing') return;
        }
        if (!(await eligible())) return;
        await this.store.setWorldState(candidate.handle, 'released');
        await this.recordLifecycle(candidate.handle, 'world.destroyed', { retried: true });
      })));
    }
    for (const [key, probedAt] of this.probedAt)
      if (probedAt < now - Math.max(2 * reconcileAfter, 60_000)) this.probedAt.delete(key);
    await this.step('orphan sandboxes', () => this.reapOrphanSandboxes());
    await this.step('provider upkeep', () => this.housekeepProviders());
    let hibernated = 0;
    const parked = await this.store.listWorldInstances('parked');
    // A world still ready under a task that ended — marked Done by hand, or a
    // teardown that never happened (the open item of wiki features/computers)
    // — is a machine nothing will use: it is freed like a parked one.
    const abandoned = [];
    for (const candidate of await this.store.listWorldInstances('ready', now - ENDED_TASK_GRACE_MS))
      if (await taskEnded(this.store, candidate.handle.id)) abandoned.push(candidate);
    const candidateIds = new Set([...parked, ...abandoned].map(candidate => candidate.handle.id));
    for (const id of this.hibernateFailures.keys()) if (!candidateIds.has(id)) this.hibernateFailures.delete(id);
    /** The failure schedule of one candidate snapshot: undefined while it waits out its backoff. */
    const attempt = (candidate: { handle: WorldHandleRef; updatedAt: number }) => {
      const failed = this.hibernateFailures.get(candidate.handle.id);
      const sameSnapshot = failed?.generation === (candidate.handle.generation ?? 1)
        && failed.updatedAt === Number(candidate.updatedAt);
      if (failed && sameSnapshot && now < failed.retryAt) return undefined;
      const attempts = sameSnapshot ? failed!.attempts + 1 : 1;
      return (error: unknown) => {
        const retryAt = now + Math.min(HIBERNATE_RETRY_MS * 2 ** (attempts - 1), HIBERNATE_RETRY_MAX_MS);
        this.hibernateFailures.set(candidate.handle.id, { generation: candidate.handle.generation ?? 1,
          updatedAt: Number(candidate.updatedAt), attempts, retryAt });
        return this.recordLifecycle(candidate.handle, 'world.hibernate_failed', {
          error: error instanceof Error ? error.message : String(error), attempts, retryAt,
        });
      };
    };
    for (const candidate of abandoned) {
      const hibernateFailed = attempt(candidate);
      if (!hibernateFailed) continue;
      await this.step(`release ${candidate.handle.id}`, async () => {
        if (await this.hibernate(candidate, { expect: 'ready', onFailure: hibernateFailed })) hibernated++;
      });
    }
    for (const candidate of parked) {
      const hibernateFailed = attempt(candidate);
      if (!hibernateFailed) continue;
      try {
      const projectId = String(candidate.handle.meta?.projectId ?? '');
      const project = (await this.store.getProject(projectId));
      const config = project ? (await this.store.effectiveTaskConfig(project, candidate.handle.id)) : undefined;
      // A task that ended keeps nothing for long (wiki features/computers): its
      // disk and machine count against the provider's limits, and a Retry
      // restores the checkpoint.
      const ended = await taskEnded(this.store, candidate.handle.id);
      const after = Math.min(config?.hibernateAfterMs ?? 7 * 24 * 60 * 60 * 1000, ended ? ENDED_TASK_GRACE_MS : Infinity);
      // A task whose Computer now asks for another size moves to a machine of
      // that size: hibernate now, and the next wake restores the checkpoint onto
      // it (checkpoint.ts restore). Worlds made before sizes were recorded are
      // left alone until their task's Computer is edited (api.ts updateParams).
      const recorded = candidate.handle.meta?.computer as MachineShape | undefined;
      const resize = recorded && config && !sameMachine(recorded, machineShape(config))
        ? { from: recorded, to: machineShape(config) } : undefined;
      // A task whose own Computer names another provider moves there the same
      // way: hibernate now, and the wake restores the checkpoint on that provider
      // (checkpoint.ts restoreWhereTaskRuns). An organization default never moves
      // a running task; only the task's own choice does.
      const target = await taskProvider(this.store, candidate.handle.id);
      let move = target && target !== candidate.handle.kind ? { from: candidate.handle.kind, to: target } : undefined;
      // "Any" leaves a world where it is until its new size is more than that
      // account allows; then the wake routes it to one that fits (compute-router.ts).
      if (!move && !target && resize && project && isAnyProvider(config?.worldProvider)
        && !fits(resize.to, await worldAccountLimits(this.store, candidate.handle, project.organizationId ?? 'org_personal')))
        move = { from: candidate.handle.kind, to: ANY_PROVIDER };
      if (!project || (!resize && !move && candidate.updatedAt > now - after)) continue;
      // A VM world keeps its disk across any size: grow it in place, never
      // hibernate it for a new size (which would drop its ignored files).
      const provider = this.worlds.get(candidate.handle.kind);
      if (resize && !move && provider.resize) {
        await this.worlds.withOperation(candidate.handle.id, async () => {
          const current = await this.store.worldStateSnapshot(candidate.handle.id);
          if (current?.state !== 'parked' || current.generation !== (candidate.handle.generation ?? 1)) return;
          const result = await provider.resize!(candidate.handle as WorldHandle, resize.to);
          await this.store.updateWorldMeta(candidate.handle, { computer: resize.to, machine: result.machine });
          await this.recordLifecycle(candidate.handle, 'world.resized', { from: resize.from, to: resize.to, inPlace: true });
          await this.checkpoints.addNotice?.(candidate.handle.id, inPlaceResizeNotice(resize.to));
        });
        continue;
      }
      if (await this.hibernate(candidate, { resize, move, onFailure: hibernateFailed })) hibernated++;
      } catch (error) {
        await hibernateFailed(error);
      }
    }
    return hibernated;
  }

  /**
   * Free a task's computer now (POST /api/tasks/:id/release-computer): its
   * world is checkpointed and its machine and disk deleted, so it holds
   * nothing at its provider until it next runs, which restores the checkpoint
   * (Git-ignored files and processes do not come back). A task that finished
   * normally needs no checkpoint: its world is just deleted. Refused while
   * the task works or something uses its world.
   */
  async release(taskId: string): Promise<{ state: 'hibernated' | 'released' }> {
    const task = await this.store.taskMetadata(taskId);
    if (!task) throw new Error(`no task ${taskId}`);
    if (task.lastView?.status === 'active') throw new Error('the task is working; stop it or wait until it pauses');
    const handle = await this.store.currentWorld(taskId);
    const snapshot = await this.store.worldStateSnapshot(taskId);
    if (!handle || !snapshot || !['ready', 'parked', 'degraded'].includes(snapshot.state))
      throw new Error('this task holds no computer');
    const lost = async () => {
      // Already lost at its provider; whatever is left is deleted.
      const world = handle as WorldHandle;
      await this.worlds.get(world.kind).destroy?.(world).catch(() => undefined);
      await this.store.setWorldState(handle, 'released');
      await this.recordLifecycle(handle, 'world.destroyed', { reason: 'released' });
      return { state: 'released' as const };
    };
    if (snapshot.state === 'degraded') return lost();
    let failure: unknown;
    const freed = await this.hibernate({ handle, updatedAt: snapshot.updatedAt },
      { expect: snapshot.state as 'ready' | 'parked', released: true, onFailure: async (error) => { failure = error; } });
    if (!freed && (await this.store.worldState(taskId)) === 'degraded') return lost();
    if (!freed) throw new Error(failure instanceof Error ? `could not free it: ${failure.message}`
      : 'something is using this computer (a terminal, a preview or a job); try again when it is idle');
    return { state: (await this.store.worldState(taskId)) === 'released' ? 'released' : 'hibernated' };
  }

  /**
   * Hibernate parked managed computers of an organization whose compute
   * credit is spent (src/world/compute-notices.ts): each is checkpointed and
   * its machine and disk deleted, so its disk stops costing what the credit
   * no longer covers. Its task restores the checkpoint when it next runs,
   * without Git-ignored files, and its agent is told so. Returns how many
   * were freed.
   */
  async hibernateForCompute(worlds: Array<{ handle: WorldHandleRef; updatedAt: number }>): Promise<number> {
    let freed = 0;
    for (const candidate of worlds) {
      const done = await this.hibernate(candidate, { reason: 'compute-spent', onFailure: (error) =>
        this.recordLifecycle(candidate.handle, 'world.hibernate_failed', { error: error instanceof Error ? error.message : String(error), reason: 'compute-spent' }),
      }).catch(() => false);
      if (!done) continue;
      freed++;
      if ((await this.store.worldState(candidate.handle.id)) === 'hibernated')
        await this.checkpoints.addNotice?.(candidate.handle.id, COMPUTE_HIBERNATED_NOTICE);
    }
    return freed;
  }

  /** Checkpoint a parked (or idle ready) world and delete it at its provider;
   * a world whose task finished normally is deleted without a checkpoint.
   * True when it was freed. Selection is only a hint: a gateway or activity
   * can resume this world while the sweep awaits another provider, so the
   * whole destructive transition is owned, and rechecked after every
   * potentially slow preparation step. */
  private async hibernate(candidate: { handle: WorldHandleRef; updatedAt: number }, options: {
    expect?: 'ready' | 'parked'; resize?: { from: MachineShape; to: MachineShape }; move?: { from: string; to: string };
    released?: boolean; onFailure?: (error: unknown) => Promise<unknown>;
    /** Why, when not the sweep's own reasons (a spent compute credit). */
    reason?: string;
  } = {}): Promise<boolean> {
    const { resize, move } = options;
    const expected = options.expect ?? 'parked';
    return this.worlds.withOperation(candidate.handle.id, () => this.worlds.withoutRecovery(async () => {
      const eligible = async (checkSelection = false) => {
        const current = await this.store.worldStateSnapshot(candidate.handle.id);
        return !!current && current.generation === (candidate.handle.generation ?? 1)
          && current.state === expected
          && (!checkSelection || current.updatedAt === Number(candidate.updatedAt))
          && await this.store.activeWorldLeaseCount(candidate.handle.id) === 0
          && !(await this.worlds.hasActiveAccess(candidate.handle.id))
          && (await this.store.taskMetadata(candidate.handle.id))?.lastView?.status !== 'active'
          // Hibernating keeps only the checkpoint, never ignored output: a world
          // holding proposed output that is not saved yet stays as it is.
          && !(await holdsUnsavedOutput(this.store, candidate.handle.id));
      };
      if (!(await eligible(true))) return false;
      const reason = options.released ? { reason: 'released' } : (await taskEnded(this.store, candidate.handle.id)) ? { reason: 'task-ended' }
        : options.reason ? { reason: options.reason } : {};
      // Its work landed: nothing in the world is needed again.
      if (!resize && !move && await finishedNormally(this.store, candidate.handle.id)) {
        try { if (!(await this.destroyAtProvider(candidate.handle, eligible))) return false; }
        catch (error) {
          if (await this.worlds.probe(candidate.handle as WorldHandle).catch(() => undefined) !== 'missing' || !(await eligible())) {
            await options.onFailure?.(error);
            return false;
          }
        }
        if (!(await eligible())) return false;
        await this.store.setWorldState(candidate.handle, 'released');
        await this.recordLifecycle(candidate.handle, 'world.destroyed', reason);
        return true;
      }
      try {
        let checkpoint = await this.store.latestWorldCheckpoint(candidate.handle.id);
        // A failed park checkpoint leaves newer work only in the sandbox, and a
        // ready world may have changed since: capture it first. If that fails
        // too the sandbox stays, under the sweep's backoff (WD-2), rather than
        // being destroyed against the older one (audit R-6).
        if (!checkpoint || checkpoint.generation !== (candidate.handle.generation ?? 1) || expected === 'ready'
          || await checkpointStale(this.store, candidate.handle))
          checkpoint = await this.checkpoints.checkpoint(candidate.handle);
        if (!checkpoint || checkpoint.generation !== (candidate.handle.generation ?? 1) || !(await eligible())) return false;
        let providerEvicted = false;
        try { if (!(await this.destroyAtProvider(candidate.handle, eligible))) return false; }
        catch (error) {
          // A timeout/5xx is not proof of eviction. Preserve the recoverable
          // state and let the next sweep retry unless the provider proves loss.
          const state = await this.worlds.probe(candidate.handle as any).catch(() => undefined);
          if (state !== 'missing' || !(await eligible())) {
            await options.onFailure?.(error);
            return false;
          }
          providerEvicted = true;
        }
        await this.store.setWorldState(candidate.handle, 'hibernated');
        await this.recordLifecycle(candidate.handle, 'world.hibernated', { checkpointId: checkpoint.id,
          ...(providerEvicted ? { providerEvicted: true } : {}), ...reason,
          ...(resize ? { resize } : {}), ...(move ? { move } : {}) });
        // A move is told when it lands (or fails), by the restore.
        if (resize && !move) await this.checkpoints.addNotice?.(candidate.handle.id, resizeNotice(resize.to));
        return true;
      } catch (error) {
        // A sandbox its provider already deleted cannot be checkpointed, ever:
        // it is lost, not failing (degraded worlds of ended tasks are released).
        if (await this.worlds.probe(candidate.handle as WorldHandle).catch(() => undefined) === 'missing' && await eligible()) {
          await this.store.setWorldState(candidate.handle, 'degraded');
          await this.recordLifecycle(candidate.handle, 'world.providerLost', {});
          return false;
        }
        await options.onFailure?.(error);
        return false;
      }
    }));
  }

  /** Delete a world at its provider, through the world itself when the
   * provider has no direct delete. */
  private async destroyAtProvider(ref: WorldHandleRef, eligible: () => Promise<boolean>): Promise<boolean> {
    const handle = ref as WorldHandle;
    const provider = this.worlds.get(handle.kind);
    if (provider.destroy) await provider.destroy(handle);
    else {
      // Opening may restore another generation: then nothing is destroyed.
      const world = await this.worlds.open(handle);
      if (!(await eligible())) return false;
      await world.destroy();
    }
    return true;
  }

  private async reconcileProviderUsage(now: number): Promise<void> {
    const organizations = (await this.store.listOrganizations());
    const organizationIds = new Set(organizations.map((organization) => organization.id));
    for (const provider of this.worlds.metered()) {
      // The installation's managed compute account first: its feed reports
      // every organization's managed machines, booked as managed (charged to
      // their compute credit). Should an organization connect the very same
      // account as its own, the rows are already booked when its feed repeats them.
      for (const organization of [{ id: MANAGED_COMPUTE }, ...organizations]) {
        // Each tenant key sees its own E2B project feed. Environment credentials
        // are imported into org_personal on boot, so an absent connection means
        // this organization must not be polled through another tenant's fallback.
        const connection = (await this.store.getWorldProviderConnection(organization.id, provider.kind));
        if (!connection?.enabled) continue;
        const fundingSource = organization.id === MANAGED_COMPUTE ? 'managed' : 'byok';
        const syncKey = `usage-sync:${organization.id}:${provider.kind}`;
        let previous: Record<string, unknown> = {};
        try { previous = JSON.parse((await this.store.kvGet(syncKey)) ?? '{}'); } catch {}
        try {
          const lastFullScanAt = Number(previous.lastFullScanAt ?? 0);
          // A read that stopped at the provider's per-sweep bound continues
          // where it stopped, so a huge feed still makes progress every sweep.
          const pending = previous.scan as { since?: number; resumeAt: number; startedAt: number } | undefined;
          const fullScan = pending ? pending.since === undefined : !lastFullScanAt || now - lastFullScanAt >= 24 * 60 * 60_000;
          const cursor = Number(previous.lastSuccessfulAt);
          const since = pending ? pending.since : !fullScan && Number.isFinite(cursor) ? cursor - 60 * 60_000 : undefined;
          const { events, resumeAt } = await provider.listUsageEvents!(organization.id, since, pending?.resumeAt);
          // Providers return a rolling history. Check immutable execution IDs
          // in batches before doing attribution or writes, including after a
          // restart. A timestamp cursor would lose late-arriving executions.
          const attribution = new Map<string, Awaited<ReturnType<Store['taskAttribution']>>>();
          for (let offset = 0; offset < events.length; offset += 100) {
            const batch = events.slice(offset, offset + 100);
            const recorded = (await this.store.recordedUsageEvents(batch.map(event => `usage:${provider.kind}:${event.id}`)));
            for (const event of batch) {
              const id = `usage:${provider.kind}:${event.id}`;
              const existing = recorded.get(id);
              if (existing?.taskId) continue;
              if (event.taskId && !attribution.has(event.taskId))
                attribution.set(event.taskId, (await this.store.taskAttribution(event.taskId)));
              const task = event.taskId ? attribution.get(event.taskId) : undefined;
              // One provider account may be connected to several organizations,
              // and its feed then reports all of their executions to each. Book
              // an execution to the organization that created the sandbox,
              // whichever organization's key read it; skip one nobody can be
              // shown to own (an unlabelled sandbox whose task was deleted).
              const owner = event.organizationId ?? task?.organizationId;
              if (!owner || !organizationIds.has(owner)) continue;
              const attributed = task?.organizationId === owner
                ? { projectId: task.projectId, taskId: event.taskId, worldId: event.taskId } : {};
              if (existing) {
                // Repairs rows an earlier sync booked to whoever read them first.
                if (existing.organizationId !== owner || attributed.taskId)
                  (await this.store.reattributeUsageEvent(id, { organizationId: owner, ...attributed }));
                continue;
              }
              const seconds = event.activeMs / 1000;
              const disk = event.kind === 'disk';
              (await this.store.recordUsage({ id,
                organizationId: owner,
                ...attributed,
                provider: provider.kind, kind: disk ? 'world.disk' : 'world.active', quantity: seconds, unit: 'second',
                fundingSource,
                // The provider's own price when it reports one (Fly, Hetzner); karmax's rates otherwise.
                costMicros: event.costMicros ?? Math.round(seconds * costMicrosPerSecond(provider.kind,
                  event.cpu, event.memoryMb, event.gpu ?? 0)),
                startedAt: event.startedAt, endedAt: event.endedAt,
                metadata: { source: 'provider-lifecycle', executionId: event.id,
                  sandboxId: event.sandboxId, cpu: event.cpu, memoryMb: event.memoryMb, gpu: event.gpu ?? 0,
                  ...(event.diskGb !== undefined ? { diskGb: event.diskGb } : {}) },
              }));
              recorded.set(id, { organizationId: owner, ...(attributed.taskId ? { taskId: attributed.taskId } : {}) });
            }
            // The PostgreSQL adapter is synchronous. Even a first-time catchup
            // must let HTTP requests and activity heartbeats make progress.
            await yieldToEventLoop();
          }
          // The events read are recorded; the cursor moves only once the scan
          // completes, to when it began (anything newer is read next time).
          const startedAt = pending?.startedAt ?? now;
          if (resumeAt !== undefined) {
            (await this.store.kvSet(syncKey, JSON.stringify({ ...previous, status: 'catching-up', at: now, error: undefined,
              scan: { ...(since !== undefined ? { since } : {}), resumeAt, startedAt } })));
            continue;
          }
          const retentionMs = 7 * 24 * 60 * 60_000;
          const lastSuccessfulAt = Number(previous.lastSuccessfulAt ?? previous.at);
          const coverageFrom = Number(previous.coverageFrom);
          (await this.store.kvSet(syncKey, JSON.stringify({ status: 'ready', at: now, lastSuccessfulAt: startedAt,
            coverageFrom: Number.isFinite(coverageFrom) ? coverageFrom : startedAt - retentionMs,
            retentionDays: 7, lastFullScanAt: fullScan ? startedAt : lastFullScanAt,
            ...(previous.gap === true || (Number.isFinite(lastSuccessfulAt) && now - lastSuccessfulAt > retentionMs)
              ? { gap: true } : {}) })));
        } catch (error) {
          (await this.store.kvSet(syncKey,
            JSON.stringify({ ...previous, status: 'error', at: now,
              error: (error instanceof Error ? error.message : String(error)).slice(0, 500) })));
        }
      }
    }
  }

  /**
   * Destroy remote sandboxes this deployment owns whose task no longer exists,
   * plus duplicate allocations that are not the task's registered world.
   *
   * This is the reaper the providers are written to depend on: Daytona creates
   * with `autoDeleteInterval: -1` (see `src/world/daytona.ts`), which turns the
   * provider's own reaper OFF on the promise that karmax reaps instead. Without
   * this pass that promise was unkept — `listSandboxes` had no caller at all —
   * so any sandbox whose task was deleted before `destroyWorld` ran billed
   * forever, with nothing on either side ever collecting it.
   *
   * A live task with no registered world is still provisioning, so every
   * matching sandbox remains ambiguous and is preserved. Once a durable handle
   * exists, however, the provider can compare its sealed id: exactly that object
   * is live and any sibling carrying the same task label is a timed-out create
   * duplicate. Providers without the comparison hook retain the conservative
   * legacy behavior. A reaper must never guess at an opaque provider id.
   */
  private async reapOrphanSandboxes(): Promise<void> {
    for (const provider of this.worlds.enumerable()) {
      // Provider credentials are organization-scoped. Hosted deployments often
      // have no ambient fallback key at all, so an unscoped list silently sees
      // nothing. Query every enabled tenant connection; retain one unscoped pass
      // only for legacy/custom providers that have no durable connection row.
      const organizationIds = (await __asyncCollections.filter([{ id: MANAGED_COMPUTE }, ...(await this.store.listOrganizations())],
        async (organization) => (await this.store.getWorldProviderConnection(organization.id, provider.kind))?.enabled))
        .map((organization) => organization.id);
      const scopes: Array<string | undefined> = organizationIds.length ? organizationIds : [undefined];
      const seen = new Set<string>();
      for (const organizationId of scopes) {
        const sandboxes = await provider.listSandboxes!(organizationId).catch(() => [] as ProviderSandboxRef[]);
        for (const sandbox of sandboxes) {
          // The same provider account can be connected to multiple organizations.
          // Never destroy/audit one object twice when their inventories overlap.
          if (seen.has(sandbox.sandboxId)) continue;
          seen.add(sandbox.sandboxId);
          // No task id means karmax cannot attribute it — never destroy blind.
          if (!sandbox.taskId) continue;
          const taskId = sandbox.taskId;
          await this.step(`orphan ${sandbox.sandboxId}`, () => this.worlds.withOperation(taskId, async () => {
            const task = (await this.store.taskMetadata(taskId));
            const current = task ? (await this.store.currentWorld(taskId)) : undefined;
            const duplicate = Boolean(task && current && sandbox.matches && sandbox.matches(current) === false);
            if (task && !duplicate) return;
            try {
              await sandbox.destroy();
              (await this.store.appendAudit({ principalId: 'system:lifecycle', action: 'world.orphanReaped',
                detail: { provider: provider.kind, sandboxId: sandbox.sandboxId, taskId: sandbox.taskId,
                  reason: duplicate ? 'duplicate' : 'task-deleted' } }));
            } catch {
              // Transient control-plane failure — the next sweep tries again.
            }
          }));
        }
      }
    }
  }

  /** Each provider's own periodic upkeep, once per connected organization. */
  private async housekeepProviders(): Promise<void> {
    for (const provider of this.worlds.housekept()) {
      for (const organization of [{ id: MANAGED_COMPUTE }, ...(await this.store.listOrganizations())]) {
        if (!(await this.store.getWorldProviderConnection(organization.id, provider.kind))?.enabled) continue;
        await this.step(`upkeep ${provider.kind} ${organization.id}`, () => provider.housekeep!(organization.id));
      }
    }
  }

  private async recordLifecycle(handle: WorldHandleRef, type: string, payload: Record<string, unknown>): Promise<void> {
    if (!(await this.store.taskMetadata(handle.id))) return;
    (await this.store.appendEvent({ taskId: handle.id, type, ts: Date.now(), payload: {
      provider: handle.provider ?? handle.kind, generation: handle.generation ?? 1, ...payload,
    } }));
  }
}

/** First retry delay after a failed hibernation; doubles per failure up to the cap. */
/** What the agent hears on its first turn on the resized computer. */
function resizeNotice(shape: MachineShape): string {
  return `This task's computer was resized to ${describeMachine(shape)}. You are on a new machine with the same files your `
    + 'repositories track, and the same uncommitted changes. Git-ignored files (installed dependencies, build output, caches) and '
    + 'running processes did not carry over: reinstall or restart what you need.';
}

/** What the agent hears after its VM world was resized in place. */
function inPlaceResizeNotice(shape: MachineShape): string {
  return `This task's computer was resized to ${describeMachine(shape)}, in place: every file is where you left it, `
    + 'including Git-ignored ones (dependencies, build output, caches). Only running processes did not carry over.';
}

/** What the agent hears when its task next runs after its parked computer
 * was hibernated because the organization's compute credit was spent. */
export const COMPUTE_HIBERNATED_NOTICE = 'While this task waited, the organization ran out of compute credit, so its parked computer '
  + 'was hibernated: it was saved and its machine and disk deleted. You are on a new machine with the same files your repositories '
  + 'track, and the same uncommitted changes. Git-ignored files (installed dependencies, build output, caches) and running processes '
  + 'did not carry over: reinstall or restart what you need.';
const HIBERNATE_RETRY_MS = 5 * 60_000;
/** How long the world of a task that ended (done, cancelled, failed) is kept
 * before its machine and disk are freed: long enough for an accidental cancel
 * to be retried without a restore. */
const ENDED_TASK_GRACE_MS = 30 * 60_000;
const HIBERNATE_RETRY_MAX_MS = 6 * 60 * 60_000;

/** How long a ready world may go untouched before its provider is probed.
 * `0` disables reconciliation entirely. */
function reconcileAfterMs(): number {
  const value = Number(process.env.KARMAX_WORLD_RECONCILE_AFTER_MS);
  return Number.isFinite(value) && value >= 0 ? value : 10 * 60_000;
}

export function costMicrosPerSecond(provider: string, cpu: number, memoryMb: number, gpu: number): number {
  if (['worktree', 'container', 'memory'].includes(provider)) return 0;
  const prefix = `KARMAX_${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const meteredDefault = provider === 'e2b' || provider === 'daytona';
  const cpuDollars = Number(process.env[`${prefix}_CPU_DOLLARS_SECOND`] ?? (meteredDefault ? 0.000014 : 0)) * cpu;
  const memoryDollars = Number(process.env[`${prefix}_GB_DOLLARS_SECOND`] ?? (meteredDefault ? 0.0000045 : 0)) * (memoryMb / 1024);
  const gpuDollars = Number(process.env[`${prefix}_GPU_DOLLARS_SECOND`] ?? 0) * gpu;
  return (cpuDollars + memoryDollars + gpuDollars) * 1_000_000;
}

function monthWindow(now: number): { from: number; to: number } {
  const date = new Date(now);
  return { from: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
    to: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) };
}

/** Proposed output of this world's task that has no snapshot yet. */
/** A task that finished normally (not marked Done by hand): its work landed. */
async function finishedNormally(store: Store, taskId: string): Promise<boolean> {
  const view = (await store.taskMetadata(taskId))?.lastView;
  return view?.status === 'done' && !view.state?.manuallyDoneFrom;
}

async function holdsUnsavedOutput(store: Store, taskId: string): Promise<boolean> {
  for (const candidate of await store.listResourceCandidates(taskId, false)) {
    if (candidate.state !== 'pending' || candidate.sourceKind !== 'path') continue;
    if (!(await store.getResourceAttachment(candidate.attachmentId))?.currentRevisionId) return true;
  }
  return false;
}
