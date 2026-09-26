/**
 * A keyed cache for slow, idempotent lookups (model discovery spawns provider
 * CLIs and takes seconds). Callers never wait on a refresh once a value exists:
 * an expired value is returned at once while one background load replaces it
 * (stale-while-revalidate), and concurrent loads of a key share one promise.
 */
export class SwrCache<K, V> {
  private entries = new Map<K, { at: number; value: V }>();
  private loads = new Map<K, Promise<{ at: number; value: V }>>();

  constructor(
    private readonly load: (key: K) => Promise<V>,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** The cached value (possibly stale) or, when there is none or `fresh` is
   *  demanded, the result of a load. */
  async get(key: K, options: { fresh?: boolean } = {}): Promise<{ at: number; value: V }> {
    const cached = this.entries.get(key);
    if (cached && !options.fresh) {
      if (this.now() - cached.at >= this.ttlMs) this.refresh(key).catch(() => undefined);
      return cached;
    }
    return this.refresh(key);
  }

  /** Start (or join) a load of `key`; the next `get` sees its result. */
  refresh(key: K): Promise<{ at: number; value: V }> {
    let pending = this.loads.get(key);
    if (!pending) {
      pending = this.load(key).then((value) => {
        const entry = { at: this.now(), value };
        this.entries.set(key, entry);
        return entry;
      }).finally(() => this.loads.delete(key));
      this.loads.set(key, pending);
    }
    return pending;
  }

  /** Forget every cached value (the inputs changed) and reload the keys that
   *  were in use, so the next reader waits for current data instead of old. */
  invalidate(): void {
    const keys = [...this.entries.keys()];
    this.entries.clear();
    for (const key of keys) this.refresh(key).catch(() => undefined);
  }
}
