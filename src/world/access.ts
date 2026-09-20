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
  constructor(private store: Store, private worlds: WorldRegistry, private runners?: RunnerPoolService,
    private resources?: import('./resources.js').ProjectResourceService) {}

  async open(taskId: string, input: WorldHandle, options: { dedicated?: boolean } = {}): Promise<MeteredWorldAccess> {
    // Admission must not hold the transition lock: an existing accessor may
    // need it to release the capacity this request is waiting for.
    // All transient access is pinned, including callers borrowing a workflow's
    // lease, until the artifact/preview/terminal operation releases it.
    const releaseAccess = this.worlds.holdAccess(input.id);
    try { return await this.openMetered(taskId, input, options, releaseAccess); }
    catch (error) { releaseAccess(); throw error; }
  }

  private async openMetered(taskId: string, input: WorldHandle, options: { dedicated?: boolean }, releaseAccess: () => void): Promise<MeteredWorldAccess> {
    const handle = ((await this.store.currentWorld(input.id)) ?? input) as WorldHandle;
    const remote = this.worlds.get(handle.kind).capabilities?.remote === true;
    let runnerLeaseId: string | undefined;
    const borrowing = remote && !!this.runners && !options.dedicated && (await this.store.activeWorldLeaseCount(handle.id)) > 0;
    if (remote && this.runners && !borrowing) {
      const projectId = String(handle.meta?.projectId ?? (await this.store.getTask(taskId))?.projectId ?? '');
      const project = (await this.store.getProject(projectId));
      if (!project) throw new Error('cloud world has no owning project');
      runnerLeaseId = (await this.runners.acquire({ project, taskId, worldId: handle.id, provider: handle.kind,
        priority: Number((await this.store.getTask(taskId))?.params.priority ?? 0) })).leaseId;
    }
    try {
      const world = await this.worlds.withOperation(handle.id, async () => {
        // A park already in flight may release the lease we intended to borrow.
        // Re-enter admission outside this lock before resuming the provider.
        if (borrowing && (await this.store.activeWorldLeaseCount(handle.id)) === 0) return undefined;
        const opened = await this.worlds.open(handle);
        return this.resources ? await this.resources.prepare(opened) : opened;
      });
      if (!world) return this.openMetered(taskId, input, options, releaseAccess);
      const openedHandle = world.handle;
      (await this.store.setWorldState(((await this.store.currentWorld(openedHandle.id)) ?? openedHandle) as WorldHandle, 'ready'));
      let released = false;
      return {
        world, handle: openedHandle, ...(runnerLeaseId ? { runnerLeaseId } : {}),
        release: async (parkIfIdle = true) => this.worlds.withOperation(openedHandle.id, async () => {
          if (released) return;
          if (runnerLeaseId) (await this.runners?.release(runnerLeaseId, openedHandle.kind));
          released = true;
          releaseAccess();
          if (parkIfIdle && remote && (await this.store.activeWorldLeaseCount(openedHandle.id)) === 0
            && this.worlds.activeAccessCount(openedHandle.id) === 0) {
            if ((await this.store.worldState(openedHandle.id)) === 'parked') return;
            await this.resources?.scrubSecrets(openedHandle).catch(() => undefined);
            await this.worlds.park(openedHandle).catch(() => undefined);
            if (await this.worlds.status(openedHandle).catch(() => 'ready') === 'parked')
              (await this.store.setWorldState(((await this.store.currentWorld(openedHandle.id)) ?? openedHandle) as WorldHandle, 'parked'));
          }
        }),
      };
    } catch (error) {
      if (runnerLeaseId) (await this.runners?.release(runnerLeaseId, handle.kind));
      releaseAccess();
      throw error;
    }
  }

  async releaseLeaseAndParkIfIdle(handle: WorldHandle, leaseId?: string): Promise<void> {
    return this.worlds.withOperation(handle.id, () => this.releaseWithinOperation(handle, leaseId));
  }

  private async releaseWithinOperation(handle: WorldHandle, leaseId?: string): Promise<void> {
    if (leaseId) (await this.runners?.release(leaseId, handle.kind));
    if (this.worlds.get(handle.kind).capabilities?.remote !== true || (await this.store.activeWorldLeaseCount(handle.id)) > 0
      || this.worlds.activeAccessCount(handle.id) > 0) return;
    if ((await this.store.worldState(handle.id)) === 'parked') return;
    await this.resources?.scrubSecrets(handle).catch(() => undefined);
    await this.worlds.park(handle).catch(() => undefined);
    if (await this.worlds.status(handle).catch(() => 'ready') === 'parked')
      (await this.store.setWorldState(((await this.store.currentWorld(handle.id)) ?? handle) as WorldHandle, 'parked'));
  }

}
