import type { Store } from '../store/db.js';
import type { Project, RunnerPool, WorldHandleRef } from '../domain/types.js';
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
    return this.store.getRunnerPool(id) ?? this.store.createRunnerPool({ id, organizationId,
      name: remote ? `Karmax managed (${provider})` : 'Local runner', provider,
      mode: remote ? 'managed' : 'customer', capacity: DEFAULT_CAPACITY, enabled: true });
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
    this.store.recordUsage({ id: `usage:${leaseId}`, organizationId: lease.organizationId, projectId: lease.projectId,
      taskId: lease.taskId, worldId: lease.worldId, provider: billedProvider, kind: 'world.active', quantity: seconds,
      unit: 'second', costMicros: Math.round(seconds * costMicrosPerSecond(billedProvider, lease.cpu, lease.memoryMb, lease.gpu)),
      startedAt, endedAt, metadata: { runnerPoolId: lease.runnerPoolId, cpu: lease.cpu, memoryMb: lease.memoryMb, gpu: lease.gpu } });
  }
}

/** Turns old parked provider state into cheap object/Git state. */
export class WorldLifecycleManager {
  private timer?: NodeJS.Timeout;
  constructor(private store: Store, private worlds: WorldRegistry, private checkpoints: WorldCheckpointService,
    private intervalMs = 60_000, private objects?: ObjectStore, private runners?: RunnerPoolService) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sweep(), this.intervalMs);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  async sweep(now = Date.now()): Promise<number> {
    for (const artifact of this.store.expiredPromotedArtifacts(now)) {
      this.store.deletePromotedArtifact(artifact.id);
      await this.objects?.delete(artifact.objectKey).catch(() => undefined);
    }
    for (const preview of this.store.expiredPreviewLeases(now)) {
      this.store.revokePreviewLease(preview.id);
      if (preview.runnerLeaseId) this.runners?.release(preview.runnerLeaseId, preview.provider);
    }
    for (const id of this.store.markLostExecutions(now - 2 * 60_000)) {
      const execution = this.store.execution(id);
      if (!execution?.runnerLeaseId) continue;
      const world = this.store.currentWorld(execution.worldId);
      this.runners?.release(execution.runnerLeaseId, world?.provider ?? world?.kind ?? 'unknown');
    }
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

  private recordLifecycle(handle: WorldHandleRef, type: string, payload: Record<string, unknown>): void {
    if (!this.store.getTask(handle.id)) return;
    this.store.appendEvent({ taskId: handle.id, type, ts: Date.now(), payload: {
      provider: handle.provider ?? handle.kind, generation: handle.generation ?? 1, ...payload,
    } });
  }
}

function costMicrosPerSecond(provider: string, cpu: number, memoryMb: number, gpu: number): number {
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
