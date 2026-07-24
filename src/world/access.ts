import type { Store } from '../store/db.js';
import type { World, WorldHandle } from './types.js';
import type { WorldRegistry } from './registry.js';
import type { RunnerPoolService } from './runners.js';

export interface MeteredWorldAccess {
  world: World;
  handle: WorldHandle;
  runnerLeaseId?: string;
  /** Release only capacity acquired by this access. Optionally park once no
   * other terminal, agent, preview, or request still owns the world. */
  release(parkIfIdle?: boolean): Promise<void>;
}

/** One accounting boundary for non-workflow world access (MCP collaboration,
 * artifacts, previews, desktops). Opening a parked provider is never allowed to
 * bypass runner admission, budget checks, usage attribution, or reparking. */
export class WorldAccessService {
  /** Transient callers may borrow an already-accounted workflow/terminal lease.
   * Track those borrows so the lease owner cannot park the world underneath an
   * in-flight artifact, preview, or WebSocket request. */
  private borrowed = new Map<string, number>();

  constructor(private store: Store, private worlds: WorldRegistry, private runners?: RunnerPoolService,
    private resources?: import('./resources.js').ProjectResourceService) {}

  async open(taskId: string, input: WorldHandle, options: { dedicated?: boolean } = {}): Promise<MeteredWorldAccess> {
    const handle = (this.store.currentWorld(input.id) ?? input) as WorldHandle;
    const remote = this.worlds.get(handle.kind).capabilities?.remote === true;
    let runnerLeaseId: string | undefined;
    const borrowing = remote && !!this.runners && !options.dedicated && this.store.activeWorldLeaseCount(handle.id) > 0;
    if (borrowing) this.borrowed.set(handle.id, (this.borrowed.get(handle.id) ?? 0) + 1);
    if (remote && this.runners && !borrowing) {
      const projectId = String(handle.meta?.projectId ?? this.store.getTask(taskId)?.projectId ?? '');
      const project = this.store.getProject(projectId);
      if (!project) throw new Error('cloud world has no owning project');
      runnerLeaseId = (await this.runners.acquire({ project, taskId, worldId: handle.id, provider: handle.kind,
        priority: Number(this.store.getTask(taskId)?.params.priority ?? 0) })).leaseId;
    }
    try {
      const opened = await this.worlds.open(handle);
      const world = this.resources ? await this.resources.prepare(opened) : opened;
      const openedHandle = world.handle;
      this.store.setWorldState((this.store.currentWorld(openedHandle.id) ?? openedHandle) as WorldHandle, 'ready');
      let released = false;
      return {
        world, handle: openedHandle, ...(runnerLeaseId ? { runnerLeaseId } : {}),
        release: async (parkIfIdle = true) => {
          if (released) return;
          released = true;
          if (runnerLeaseId) this.runners?.release(runnerLeaseId, openedHandle.kind);
          if (borrowing) this.releaseBorrow(openedHandle.id);
          if (parkIfIdle && remote && this.store.activeWorldLeaseCount(openedHandle.id) === 0
            && (this.borrowed.get(openedHandle.id) ?? 0) === 0) {
            if (this.store.worldState(openedHandle.id) === 'parked') return;
            await this.resources?.scrubSecrets(openedHandle).catch(() => undefined);
            await this.worlds.park(openedHandle).catch(() => undefined);
            if (await this.worlds.status(openedHandle).catch(() => 'ready') === 'parked')
              this.store.setWorldState((this.store.currentWorld(openedHandle.id) ?? openedHandle) as WorldHandle, 'parked');
          }
        },
      };
    } catch (error) {
      if (runnerLeaseId) this.runners?.release(runnerLeaseId, handle.kind);
      if (borrowing) this.releaseBorrow(handle.id);
      throw error;
    }
  }

  async releaseLeaseAndParkIfIdle(handle: WorldHandle, leaseId?: string): Promise<void> {
    if (leaseId) this.runners?.release(leaseId, handle.kind);
    if (this.worlds.get(handle.kind).capabilities?.remote !== true || this.store.activeWorldLeaseCount(handle.id) > 0
      || (this.borrowed.get(handle.id) ?? 0) > 0) return;
    if (this.store.worldState(handle.id) === 'parked') return;
    await this.resources?.scrubSecrets(handle).catch(() => undefined);
    await this.worlds.park(handle).catch(() => undefined);
    if (await this.worlds.status(handle).catch(() => 'ready') === 'parked')
      this.store.setWorldState((this.store.currentWorld(handle.id) ?? handle) as WorldHandle, 'parked');
  }

  private releaseBorrow(worldId: string): void {
    const next = (this.borrowed.get(worldId) ?? 1) - 1;
    if (next > 0) this.borrowed.set(worldId, next);
    else this.borrowed.delete(worldId);
  }
}
