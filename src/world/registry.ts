import { AsyncLocalStorage } from 'node:async_hooks';
import { WorldOperationLock } from './operation-lock.js';
import { SharedWorldCoordination } from './shared-coordination.js';
import { World, WorldHandle, WorldKind, WorldLifecycleState, WorldProvider, WorldSpec } from './types.js';
import { WorktreeProvider } from './worktree.js';
import { MemoryWorldProvider } from './memory.js';
import { ContainerWorldProvider } from './container.js';
import { E2BWorldProvider } from './e2b.js';
import { DaytonaWorldProvider } from './daytona.js';

/**
 * Selects a world provider by kind. `createWorld` dispatches to the configured
 * provider (SPEC §11.1); the workflow talks only to the WorldHandle, so
 * worktree → container → remote is a config change, not a code change.
 */
export class WorldRegistry {
  private readonly recoveryDisabled = new AsyncLocalStorage<boolean>();
  private readonly operations: WorldOperationLock;
  private readonly shared?: SharedWorldCoordination;
  private readonly accessors = new Map<string, number>();
  private providers = new Map<WorldKind, WorldProvider>();
  private resolveHandle?: (handle: WorldHandle) => WorldHandle | undefined | Promise<WorldHandle | undefined>;
  private recover?: (handle: WorldHandle, error: unknown) => Promise<WorldHandle | undefined>;

  constructor(options: { coordinationDirectory?: string } = {}) {
    if (options.coordinationDirectory) this.shared = new SharedWorldCoordination(options.coordinationDirectory);
    this.operations = new WorldOperationLock(this.shared);
    this.register(new WorktreeProvider());
    this.register(new MemoryWorldProvider());
    this.register(new ContainerWorldProvider());
    this.register(new E2BWorldProvider());
    this.register(new DaytonaWorldProvider());
  }

  register(p: WorldProvider) {
    this.providers.set(p.kind, p);
  }

  setHandleResolver(resolve: (handle: WorldHandle) => WorldHandle | undefined | Promise<WorldHandle | undefined>): void {
    this.resolveHandle = resolve;
  }

  setRecoveryHandler(recover: (handle: WorldHandle, error: unknown) => Promise<WorldHandle | undefined>): void {
    this.recover = recover;
  }

  get(kind: WorldKind): WorldProvider {
    const p = this.providers.get(kind);
    if (!p) throw new Error(`no world provider for kind "${kind}"`);
    return p;
  }

  catalog(): Array<{ provider: string; parkable: boolean; capabilities?: WorldProvider['capabilities'] }> {
    return [...this.providers.values()].map((provider) => ({ provider: provider.kind,
      parkable: provider.parkable, capabilities: provider.capabilities }));
  }

  /** Providers that can enumerate the sandboxes this deployment owns, for the
   *  lifecycle sweep's orphan reaper (`WorldLifecycleManager.sweep`). */
  enumerable(): WorldProvider[] {
    return [...this.providers.values()].filter((provider) => typeof provider.listSandboxes === 'function');
  }

  /** Providers whose control plane exposes completed billable executions. */
  metered(): WorldProvider[] {
    return [...this.providers.values()].filter((provider) => typeof provider.listUsageEvents === 'function');
  }

  async create(kind: WorldKind, spec: WorldSpec): Promise<World> {
    return this.withOperation(spec.taskId, () => {
      spec.signal?.throwIfAborted();
      return this.get(kind).create(spec);
    });
  }

  withOperation<T>(worldId: string, operation: () => Promise<T>): Promise<T> {
    return this.operations.run(worldId, operation);
  }

  async holdAccess(worldId: string): Promise<() => void> {
    const releaseShared = await this.shared?.holdAccess(worldId);
    this.accessors.set(worldId, this.activeAccessCount(worldId) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseShared?.();
      const count = this.activeAccessCount(worldId) - 1;
      if (count > 0) this.accessors.set(worldId, count);
      else this.accessors.delete(worldId);
    };
  }
  activeAccessCount(worldId: string): number { return this.accessors.get(worldId) ?? 0; }

  async hasActiveAccess(worldId: string): Promise<boolean> {
    return this.shared ? this.shared.hasAccess(worldId) : this.activeAccessCount(worldId) > 0;
  }

  withoutRecovery<T>(operation: () => Promise<T>): Promise<T> {
    return this.recoveryDisabled.run(true, operation);
  }

  async open(handle: WorldHandle): Promise<World> {
    return this.withOperation(handle.id, async () => {
      const current = (await this.resolveHandle?.(handle)) ?? handle;
      try {
        return await this.get(current.kind).open(current);
      } catch (error) {
        if (this.recoveryDisabled.getStore()) throw error;
        const restored = await this.recover?.(current, error);
        if (!restored) throw error;
        return this.get(restored.kind).open(restored);
      }
    });
  }

  async park(handle: WorldHandle): Promise<WorldHandle> {
    return this.withOperation(handle.id, async () => {
      const current = (await this.resolveHandle?.(handle)) ?? handle;
      const provider = this.get(current.kind);
      return provider.park ? provider.park(current) : current;
    });
  }

  async status(handle: WorldHandle): Promise<WorldLifecycleState> {
    const current = (await this.resolveHandle?.(handle)) ?? handle;
    const provider = this.get(current.kind);
    return provider.status ? provider.status(current) : 'ready';
  }

  /** Provider-authoritative liveness for reconciliation; undefined = unknown. */
  async probe(handle: WorldHandle): Promise<WorldLifecycleState | undefined> {
    const current = (await this.resolveHandle?.(handle)) ?? handle;
    return this.get(current.kind).probe?.(current);
  }
}
