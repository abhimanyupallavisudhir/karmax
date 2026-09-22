import { AsyncLocalStorage } from 'node:async_hooks';

/** Transaction boundary for Map-backed test stores; nested calls share it. */
export function memoryTransaction(kv: Map<string, string>, audit: unknown[] = []) {
  const scope = new AsyncLocalStorage<{ active: boolean }>();
  let tail = Promise.resolve();
  return async function transaction<T>(operation: () => Promise<T>): Promise<T> {
    const inherited = scope.getStore();
    if (inherited) {
      if (!inherited.active) throw new Error('transaction is already closed');
      return operation();
    }
    const run = async () => {
      const context = { active: true };
      const previous = new Map(kv);
      const auditLength = audit.length;
      try { return await scope.run(context, operation); }
      catch (error) {
        kv.clear();
        for (const [key, value] of previous) kv.set(key, value);
        audit.length = auditLength;
        throw error;
      } finally { context.active = false; }
    };
    const result = tail.then(run);
    tail = result.then(() => {}, () => {});
    return result;
  };
}
