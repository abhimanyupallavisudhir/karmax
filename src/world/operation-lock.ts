import { AsyncLocalStorage } from 'node:async_hooks';

/** In-process world-transition exclusion. Re-entrant recovery/open calls share
 * their caller's turn; a context escaping a completed turn must acquire anew.
 * This is not a distributed lease and must not be used to justify multi-process
 * world ownership without a shared coordination layer. */
export class WorldOperationLock {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly scopes = new AsyncLocalStorage<Map<string, { active: boolean }>>();

  async run<T>(worldId: string, operation: () => Promise<T>): Promise<T> {
    const inherited = this.scopes.getStore();
    if (inherited?.get(worldId)?.active) return operation();
    const previous = this.tails.get(worldId);
    let release!: () => void;
    const tail = new Promise<void>(resolve => { release = resolve; });
    this.tails.set(worldId, tail);
    await previous;
    const scope = { active: true };
    const context = new Map(inherited);
    context.set(worldId, scope);
    try { return await this.scopes.run(context, operation); }
    finally {
      scope.active = false;
      release();
      if (this.tails.get(worldId) === tail) this.tails.delete(worldId);
    }
  }
}
