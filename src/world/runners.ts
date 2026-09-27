import * as __asyncCollections from '../util/async-collections.js';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { Store } from '../store/db.js';
import type { Project, RunnerPool, WorldHandleRef } from '../domain/types.js';
import type { ProviderSandboxRef } from './types.js';
import type { WorldRegistry } from './registry.js';
import type { WorldCheckpointService } from './checkpoint.js';
import type { ObjectStore } from '../store/objects.js';

// Private/explicit pools retain physical resource totals. Hosted customer-owned
// pools ignore these totals and derive active worlds from plan concurrency.
const DEFAULT_CAPACITY = { activeWorlds: 20, cpu: 40, memoryMb: 81_920, gpu: 0 };
const STALE_PARKED_LEASE_MS = 2 * 60_000;

/** Durable admission and cost attribution for execution-plane capacity. The DB
 * queue is the source of truth, so a waiting activity can restart on any worker. */
export class RunnerPoolService {
  constructor(private store: Store) {}

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
    heartbeat?: () => void; signal?: AbortSignal; pollMs?: number }): Promise<{ leaseId: string; runnerPoolId: string }> {
    if (input.signal?.aborted)
      throw input.signal.reason ?? new Error('runner lease cancelled');
    const config = (await this.store.effectiveProjectConfig(input.project));
    const pool = (await this.ensureDefaultPool(input.project, input.provider));
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
    // lifecycle events, reconciled by WorldLifecycleManager below.
    if (billedProvider === 'e2b') return;
    (await this.store.recordUsage({ id: `usage:${leaseId}`, organizationId: lease.organizationId, projectId: lease.projectId,
      taskId: lease.taskId, worldId: lease.worldId, provider: billedProvider, kind: 'world.active', quantity: seconds,
      unit: 'second', costMicros: Math.round(seconds * costMicrosPerSecond(billedProvider, lease.cpu, lease.memoryMb, lease.gpu)),
      startedAt, endedAt, fundingSource: (await this.store.getRunnerPool(lease.runnerPoolId))?.mode === 'managed' ? 'managed' : 'byok',
      metadata: { runnerPoolId: lease.runnerPoolId, cpu: lease.cpu, memoryMb: lease.memoryMb, gpu: lease.gpu } }));
  }

  /** Repair reservations whose activity owner disappeared before it could
   * publish or release them. Terminal tasks own no workflow capacity. Likewise,
   * a parked/hibernated/released world cannot own an old active reservation: a
   * genuine wake-up has a short grace period in which to mark the world ready. */
  async reconcileWorldLeases(now = Date.now()): Promise<number> {
    let released = 0;
    for (const lease of (await this.store.unreleasedWorldLeases())) {
      const task = (await this.store.taskMetadata(String(lease.taskId)));
      const world = (await this.store.currentWorld(String(lease.worldId)));
      const worldState = (await this.store.worldState(String(lease.worldId)));
      const passiveWorld = ['parked', 'hibernated', 'released'].includes(worldState ?? '');
      const terminal = !task || ['done', 'cancelled', 'failed'].includes(task.lastView?.status ?? 'active');
      const stale = Number(lease.acquiredAt ?? lease.createdAt) <= now - STALE_PARKED_LEASE_MS;
      const borrowed = (await this.store.worldLeaseHasLiveAccessor(String(lease.id), now));
      const terminalWorkflowLease = terminal
        && (!world || world.meta?.worldLeaseId === lease.id || (lease.state === 'active' && stale && !borrowed));
      const stalePassiveLease = lease.state === 'active'
        && passiveWorld
        && stale
        && !borrowed;
      if (!terminalWorkflowLease && !stalePassiveLease) continue;
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

  private async sweepOnce(now: number): Promise<number> {
    (await this.runners?.reconcileWorldLeases(now));
    await this.checkpoints.collectGarbage?.();
    await this.reconcileProviderUsage(now);
    for (const artifact of (await this.store.expiredPromotedArtifacts(now))) {
      (await this.store.deletePromotedArtifact(artifact.id));
      await this.objects?.delete(artifact.objectKey).catch(() => undefined);
    }
    for (const preview of (await this.store.expiredPreviewLeases(now))) {
      (await this.store.revokePreviewLease(preview.id));
      const handle = (await this.store.currentWorld(preview.worldId)) as any;
      if (handle && this.access) await this.access.releaseLeaseAndParkIfIdle(handle, preview.runnerLeaseId);
      else if (preview.runnerLeaseId) (await this.runners?.release(preview.runnerLeaseId, preview.provider));
    }
    for (const id of (await this.store.markLostExecutions(now - 2 * 60_000))) {
      const execution = (await this.store.execution(id));
      if (!execution?.runnerLeaseId) continue;
      const world = (await this.store.currentWorld(execution.worldId));
      if (world && this.access) await this.access.releaseLeaseAndParkIfIdle(world as any, execution.runnerLeaseId);
      else (await this.runners?.release(execution.runnerLeaseId, world?.provider ?? world?.kind ?? 'unknown'));
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
        await this.worlds.withOperation(candidate.handle.id, async () => {
          const unchanged = async () => {
            const current = await this.store.worldStateSnapshot(candidate.handle.id);
            return current?.state === 'ready'
              && current.generation === (candidate.handle.generation ?? 1)
              && current.updatedAt === Number(candidate.updatedAt);
          };
          if (!(await unchanged())) return;
          this.probedAt.set(key, now);
          const state = await this.worlds.probe(candidate.handle as any).catch(() => undefined);
          if (state !== 'missing' || !(await unchanged())) return;
          await this.store.setWorldState(candidate.handle, 'degraded');
          await this.recordLifecycle(candidate.handle, 'world.providerLost', {});
        });
      }
    }
    for (const candidate of await this.store.listWorldInstances('degraded')) {
      if (!candidate.handle.meta?.teardownPending) continue;
      await this.worlds.withOperation(candidate.handle.id, () => this.worlds.withoutRecovery(async () => {
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
      }));
    }
    for (const [key, probedAt] of this.probedAt)
      if (probedAt < now - Math.max(2 * reconcileAfter, 60_000)) this.probedAt.delete(key);
    await this.reapOrphanSandboxes();
    let hibernated = 0;
    for (const candidate of (await this.store.listWorldInstances('parked'))) {
      try {
      const projectId = String(candidate.handle.meta?.projectId ?? '');
      const project = (await this.store.getProject(projectId));
      const after = project ? (await this.store.effectiveProjectConfig(project)).hibernateAfterMs ?? 7 * 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
      if (!project || candidate.updatedAt > now - after) continue;
      // Selection is only a hint: a gateway or activity can resume this world
      // while the sweep awaits another provider. Own the complete destructive
      // transition, and recheck after every potentially slow preparation step.
      await this.worlds.withOperation(candidate.handle.id, () => this.worlds.withoutRecovery(async () => {
        const eligible = async (checkSelection = false) => {
          const current = await this.store.worldStateSnapshot(candidate.handle.id);
          return !!current && current.generation === (candidate.handle.generation ?? 1)
            && current.state === 'parked'
            && (!checkSelection || current.updatedAt === Number(candidate.updatedAt))
            && await this.store.activeWorldLeaseCount(candidate.handle.id) === 0
            && !(await this.worlds.hasActiveAccess(candidate.handle.id))
            && (await this.store.taskMetadata(candidate.handle.id))?.lastView?.status !== 'active';
        };
        if (!(await eligible(true))) return;
        let checkpoint = await this.store.latestWorldCheckpoint(candidate.handle.id);
        if (!checkpoint || checkpoint.generation !== (candidate.handle.generation ?? 1))
          checkpoint = await this.checkpoints.checkpoint(candidate.handle);
        if (!checkpoint || checkpoint.generation !== (candidate.handle.generation ?? 1) || !(await eligible())) return;
        try {
          const provider = this.worlds.get(candidate.handle.kind);
          if (provider.destroy) await provider.destroy(candidate.handle as any);
          else {
            const world = await this.worlds.open(candidate.handle as any);
            if (!(await eligible())) return;
            await world.destroy();
          }
        } catch (error) {
          // A timeout/5xx is not proof of eviction. Preserve the recoverable
          // state and let the next sweep retry unless the provider proves loss.
          const state = await this.worlds.probe(candidate.handle as any).catch(() => undefined);
          if (state !== 'missing' || !(await eligible())) {
            await this.recordLifecycle(candidate.handle, 'world.hibernate_failed', {
              error: error instanceof Error ? error.message : String(error),
            });
            return;
          }
          await this.store.setWorldState(candidate.handle, 'hibernated');
          await this.recordLifecycle(candidate.handle, 'world.hibernated', { checkpointId: checkpoint.id, providerEvicted: true });
          hibernated++;
          return;
        }
        await this.store.setWorldState(candidate.handle, 'hibernated');
        await this.recordLifecycle(candidate.handle, 'world.hibernated', { checkpointId: checkpoint.id });
        hibernated++;
      }));
      } catch (error) {
        await this.recordLifecycle(candidate.handle, 'world.hibernate_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return hibernated;
  }

  private async reconcileProviderUsage(now: number): Promise<void> {
    for (const provider of this.worlds.metered()) {
      for (const organization of (await this.store.listOrganizations())) {
        // Each tenant key sees its own E2B project feed. Environment credentials
        // are imported into org_personal on boot, so an absent connection means
        // this organization must not be polled through another tenant's fallback.
        const connection = (await this.store.getWorldProviderConnection(organization.id, provider.kind));
        if (!connection?.enabled) continue;
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
            const recorded = (await this.store.recordedUsageEventIds(batch.map(event => `usage:${provider.kind}:${event.id}`)));
            for (const event of batch) {
              const id = `usage:${provider.kind}:${event.id}`;
              if (recorded.has(id)) continue;
              if (event.taskId && !attribution.has(event.taskId))
                attribution.set(event.taskId, (await this.store.taskAttribution(event.taskId)));
              const task = event.taskId ? attribution.get(event.taskId) : undefined;
              const attributed = task?.organizationId === organization.id;
              const seconds = event.activeMs / 1000;
              (await this.store.recordUsage({ id,
                organizationId: organization.id,
                ...(attributed ? { projectId: task.projectId, taskId: event.taskId, worldId: event.taskId } : {}),
                provider: provider.kind, kind: 'world.active', quantity: seconds, unit: 'second',
                fundingSource: 'byok',
                costMicros: Math.round(seconds * costMicrosPerSecond(provider.kind,
                  event.cpu, event.memoryMb, event.gpu ?? 0)),
                startedAt: event.startedAt, endedAt: event.endedAt,
                metadata: { source: 'provider-lifecycle', executionId: event.id,
                  sandboxId: event.sandboxId, cpu: event.cpu, memoryMb: event.memoryMb, gpu: event.gpu ?? 0 },
              }));
              recorded.add(id);
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
      const organizationIds = (await __asyncCollections.filter((await this.store.listOrganizations()), async (organization) => (await this.store.getWorldProviderConnection(organization.id, provider.kind))?.enabled))
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
          await this.worlds.withOperation(taskId, async () => {
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
          });
        }
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
