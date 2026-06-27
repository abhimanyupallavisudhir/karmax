import { World, WorldHandle, WorldKind, WorldProvider, WorldSpec } from './types.js';
import { WorktreeProvider } from './worktree.js';
import { MemoryWorldProvider } from './memory.js';
import { ContainerWorldProvider } from './container.js';

/**
 * Selects a world provider by kind. `createWorld` dispatches to the configured
 * provider (SPEC §11.1); the workflow talks only to the WorldHandle, so
 * worktree → container → remote is a config change, not a code change.
 */
export class WorldRegistry {
  private providers = new Map<WorldKind, WorldProvider>();

  constructor() {
    this.register(new WorktreeProvider());
    this.register(new MemoryWorldProvider());
    this.register(new ContainerWorldProvider());
  }

  register(p: WorldProvider) {
    this.providers.set(p.kind, p);
  }

  get(kind: WorldKind): WorldProvider {
    const p = this.providers.get(kind);
    if (!p) throw new Error(`no world provider for kind "${kind}"`);
    return p;
  }

  async create(kind: WorldKind, spec: WorldSpec): Promise<World> {
    return this.get(kind).create(spec);
  }

  async open(handle: WorldHandle): Promise<World> {
    return this.get(handle.kind).open(handle);
  }
}
