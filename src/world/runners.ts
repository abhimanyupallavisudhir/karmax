import type { Store } from '../store/db.js';
import type { Project, RunnerPool, WorldHandleRef } from '../domain/types.js';
import type { ProviderSandboxRef } from './types.js';
import type { WorldRegistry } from './registry.js';
import type { WorldCheckpointService } from './checkpoint.js';
import type { ObjectStore } from '../store/objects.js';

const DEFAULT_CAPACITY = { activeWorlds: 20, cpu: 40, memoryMb: 81_920, gpu: 0 };

/** Durable admission and cost attribution for execution-plane capacity. The DB
 * queue is the source of truth, so a waiting activity can restart on any worker. */
export class RunnerPoolService {
  constructor(private store: Store) {}

  ensureDefaultPool(project: Project, provider: string): RunnerPool {
    const organizationId = project.organizationId!;
    const requested = this.store.effectiveProjectConfig(project).runnerPoolId;
    if (requested) {
      const pool = this.store.getRunnerPool(requested);
      if (!pool || pool.organizationId !== organizationId || !pool.enabled) throw new Error('configured runner pool is unavailable');
      if (pool.provider !== provider) throw new Error(`configured runner pool uses ${pool.provider}, not ${provider}`);
      return pool;
    }
    const remote = !['worktree', 'container', 'memory'].includes(provider);
    const id = `${organizationId}:${remote ? `managed-${provider}` : 'local'}`;
    const existing = this.store.getRunnerPool(id);
    if (existing) {
      // Older releases named the default remote pool "managed" even though the
      // launch rail is now strictly organization BYOK. The provider connection
      // boundary separately fails closed when that organization has no key.
      if (remote && this.store.hosted && existing.mode === 'managed')
        return this.store.createRunnerPool({ ...existing, name: `${provider.toUpperCase()} · organization BYOK`, mode: 'customer' });
      return existing;
    }
    return this.store.createRunnerPool({ id, organizationId,
      name: remote ? `${provider.toUpperCase()} · organization BYOK` : 'Local runner', provider,
      // Remote launch credentials are organization-owned by default. A pool is
      // capacity policy, not a resale entitlement or transferable provider credit.
      mode: 'customer', capacity: DEFAULT_CAPACITY, enabled: true });
  }

  async acquire(input: { project: Project; taskId: string; worldId: string; provider: string; priority?: number;
    heartbeat?: () => void; signal?: AbortSignal; pollMs?: number }): Promise<{ leaseId: string; runnerPoolId: string }> {
    const config = this.store.effectiveProjectConfig(input.project);
    const pool = this.ensureDefaultPool(input.project, input.provider);
    const month = monthWindow(Date.now());
    const organizationPolicy = this.store.getOrganizationExecutionPolicy(input.project.organizationId!);
    const organizationSpent = this.store.usageSummary(input.project.organizationId!, month.from, month.to).costMicros;
    if (organizationPolicy.monthlyBudgetMicros != null && organizationSpent >= organizationPolicy.monthlyBudgetMicros)
      throw new Error('organization monthly cloud budget is exhausted');
    const projectSpent = this.store.usageSummary(input.project.organizationId!, month.from, month.to, input.project.id).costMicros;
    if (input.project.config.monthlyBudgetMicros != null && projectSpent >= input.project.config.monthlyBudgetMicros)
      throw new Error('project monthly cloud budget is exhausted');
    const requested = this.store.requestWorldLease({ runnerPoolId: pool.id, organizationId: input.project.organizationId!,
      projectId: input.project.id, taskId: input.taskId, worldId: input.worldId,
      cpu: config.resources?.cpu, memoryMb: config.resources?.memoryMb,
      gpu: config.resources?.gpu, priority: input.priority });
    while (!this.store.worldLease(requested.id)?.acquiredAt) {
      if (input.signal?.aborted) {
        this.store.releaseWorldLease(requested.id);
        throw input.signal.reason ?? new Error('runner lease cancelled');
      }
      input.heartbeat?.();
      await new Promise((resolve) => setTimeout(resolve, Math.max(100, input.pollMs ?? 1_000)));
    }
    return { leaseId: requested.id, runnerPoolId: pool.id };
  }

  release(leaseId: string, provider: string): void {
    const lease = this.store.worldLease(leaseId);
    if (!lease || lease.state === 'released') return;
    const billedProvider = this.store.getRunnerPool(lease.runnerPoolId)?.provider ?? provider;
    const endedAt = Date.now();
    this.store.releaseWorldLease(leaseId);
    const startedAt = Number(lease.acquiredAt ?? lease.createdAt);
    const seconds = Math.max(0, (endedAt - startedAt) / 1000);
    // E2B runner leases reserve concurrency; they are not billing intervals.
    // Its sandboxes auto-pause independently and report exact executions through
    // lifecycle events, reconciled by WorldLifecycleManager below.
    if (billedProvider === 'e2b') return;
    this.store.recordUsage({ id: `usage:${leaseId}`, organizationId: lease.organizationId, projectId: lease.projectId,
      taskId: lease.taskId, worldId: lease.worldId, provider: billedProvider, kind: 'world.active', quantity: seconds,
      unit: 'second', costMicros: Math.round(seconds * costMicrosPerSecond(billedProvider, lease.cpu, lease.memoryMb, lease.gpu)),
      startedAt, endedAt, fundingSource: this.store.getRunnerPool(lease.runnerPoolId)?.mode === 'managed' ? 'managed' : 'byok',
      metadata: { runnerPoolId: lease.runnerPoolId, cpu: lease.cpu, memoryMb: lease.memoryMb, gpu: lease.gpu } });
  }
}

/** Turns old parked provider state into cheap object/Git state. */
export class WorldLifecycleManager {
  private timer?: NodeJS.Timeout;
  /** Last provider probe per world generation, so reconciliation does not hit
   * the provider control plane on every sweep tick. */
  private probedAt = new Map<string, number>();
  constructor(private store: Store, private worlds: WorldRegistry, private checkpoints: WorldCheckpointService,
    private intervalMs = 60_000, private objects?: ObjectStore, private runners?: RunnerPoolService,
    private access?: import('./access.js').WorldAccessService) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sweep(), this.intervalMs);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  async sweep(now = Date.now()): Promise<number> {
    await this.reconcileProviderUsage(now);
    for (const artifact of this.store.expiredPromotedArtifacts(now)) {
      this.store.deletePromotedArtifact(artifact.id);
      await this.objects?.delete(artifact.objectKey).catch(() => undefined);
    }
    for (const preview of this.store.expiredPreviewLeases(now)) {
      this.store.revokePreviewLease(preview.id);
      const handle = this.store.currentWorld(preview.worldId) as any;
      if (handle && this.access) await this.access.releaseLeaseAndParkIfIdle(handle, preview.runnerLeaseId);
      else if (preview.runnerLeaseId) this.runners?.release(preview.runnerLeaseId, preview.provider);
    }
    for (const id of this.store.markLostExecutions(now - 2 * 60_000)) {
      const execution = this.store.execution(id);
      if (!execution?.runnerLeaseId) continue;
      const world = this.store.currentWorld(execution.worldId);
      if (world && this.access) await this.access.releaseLeaseAndParkIfIdle(world as any, execution.runnerLeaseId);
      else this.runners?.release(execution.runnerLeaseId, world?.provider ?? world?.kind ?? 'unknown');
    }
    // Reconciliation: an active remote world whose sandbox disappeared
    // out-of-band (manual deletion, provider eviction) should surface as
    // degraded now, not as an opaque failure on the task's next operation.
    // Local providers have no probe and are skipped.
    const reconcileAfter = reconcileAfterMs();
    if (reconcileAfter > 0) {
      for (const candidate of this.store.listWorldInstances('ready', now - reconcileAfter)) {
        const key = `${candidate.handle.id}:${candidate.handle.generation ?? 1}`;
        if ((this.probedAt.get(key) ?? 0) > now - reconcileAfter) continue;
        this.probedAt.set(key, now);
        const state = await this.worlds.probe(candidate.handle as any).catch(() => undefined);
        if (state !== 'missing') continue;
        this.store.setWorldState(candidate.handle, 'degraded');
        this.recordLifecycle(candidate.handle, 'world.providerLost', {});
      }
    }
    await this.reapOrphanSandboxes();
    let hibernated = 0;
    for (const candidate of this.store.listWorldInstances('parked')) {
      const projectId = String(candidate.handle.meta?.projectId ?? '');
      const project = this.store.getProject(projectId);
      const after = project ? this.store.effectiveProjectConfig(project).hibernateAfterMs ?? 7 * 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
      if (!project || candidate.updatedAt > now - after) continue;
      const checkpoint = this.store.latestWorldCheckpoint(candidate.handle.id)
        ?? await this.checkpoints.checkpoint(candidate.handle);
      if (!checkpoint) continue;
      try {
        const world = await this.worlds.open(candidate.handle as any);
        await world.destroy();
        this.store.setWorldState(candidate.handle, 'hibernated');
        this.recordLifecycle(candidate.handle, 'world.hibernated', { checkpointId: checkpoint.id });
        hibernated++;
      } catch {
        // A provider that has already evicted the parked sandbox is effectively
        // hibernated as long as the portable checkpoint exists.
        this.store.setWorldState(candidate.handle, 'hibernated');
        this.recordLifecycle(candidate.handle, 'world.hibernated', { checkpointId: checkpoint.id, providerEvicted: true });
        hibernated++;
      }
    }
    return hibernated;
  }

  private async reconcileProviderUsage(now: number): Promise<void> {
    for (const provider of this.worlds.metered()) {
      for (const organization of this.store.listOrganizations()) {
        // Each tenant key sees its own E2B project feed. Environment credentials
        // are imported into org_personal on boot, so an absent connection means
        // this organization must not be polled through another tenant's fallback.
        const connection = this.store.getWorldProviderConnection(organization.id, provider.kind);
        if (!connection?.enabled) continue;
        const syncKey = `usage-sync:${organization.id}:${provider.kind}`;
        let previous: Record<string, unknown> = {};
        try { previous = JSON.parse(this.store.kvGet(syncKey) ?? '{}'); } catch {}
        try {
          const events = await provider.listUsageEvents!(organization.id);
          for (const event of events) {
            const task = event.taskId ? this.store.getTask(event.taskId) : undefined;
            const project = task ? this.store.getProject(task.projectId) : undefined;
            const attributed = project?.organizationId === organization.id;
            const seconds = event.activeMs / 1000;
            this.store.recordUsage({ id: `usage:${provider.kind}:${event.id}`,
              organizationId: organization.id,
              ...(attributed ? { projectId: project.id, taskId: task!.id, worldId: task!.id } : {}),
              provider: provider.kind, kind: 'world.active', quantity: seconds, unit: 'second',
              fundingSource: 'byok',
              costMicros: Math.round(seconds * costMicrosPerSecond(provider.kind,
                event.cpu, event.memoryMb, event.gpu ?? 0)),
              startedAt: event.startedAt, endedAt: event.endedAt,
              metadata: { source: 'provider-lifecycle', executionId: event.id,
                sandboxId: event.sandboxId, cpu: event.cpu, memoryMb: event.memoryMb, gpu: event.gpu ?? 0 },
            });
          }
          const retentionMs = 7 * 24 * 60 * 60_000;
          const lastSuccessfulAt = Number(previous.lastSuccessfulAt ?? previous.at);
          const coverageFrom = Number(previous.coverageFrom);
          this.store.kvSet(syncKey, JSON.stringify({ status: 'ready', at: now, lastSuccessfulAt: now,
            coverageFrom: Number.isFinite(coverageFrom) ? coverageFrom : now - retentionMs,
            retentionDays: 7,
            ...(previous.gap === true || (Number.isFinite(lastSuccessfulAt) && now - lastSuccessfulAt > retentionMs)
              ? { gap: true } : {}) }));
        } catch (error) {
          this.store.kvSet(syncKey,
            JSON.stringify({ ...previous, status: 'error', at: now,
              error: (error instanceof Error ? error.message : String(error)).slice(0, 500) }));
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
      const organizationIds = this.store.listOrganizations()
        .filter((organization) => this.store.getWorldProviderConnection(organization.id, provider.kind)?.enabled)
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
          const task = this.store.getTask(sandbox.taskId);
          const current = task ? this.store.currentWorld(sandbox.taskId) : undefined;
          const duplicate = Boolean(task && current && sandbox.matches && !sandbox.matches(current));
          if (task && !duplicate) continue;
          try {
            await sandbox.destroy();
            this.store.appendAudit({ principalId: 'system:lifecycle', action: 'world.orphanReaped',
              detail: { provider: provider.kind, sandboxId: sandbox.sandboxId, taskId: sandbox.taskId,
                reason: duplicate ? 'duplicate' : 'task-deleted' } });
          } catch {
            // Transient control-plane failure — the next sweep tries again.
          }
        }
      }
    }
  }

  private recordLifecycle(handle: WorldHandleRef, type: string, payload: Record<string, unknown>): void {
    if (!this.store.getTask(handle.id)) return;
    this.store.appendEvent({ taskId: handle.id, type, ts: Date.now(), payload: {
      provider: handle.provider ?? handle.kind, generation: handle.generation ?? 1, ...payload,
    } });
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
