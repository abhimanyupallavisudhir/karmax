/** Bounded independent I/O. Drain in-flight calls before surfacing failure so
 * callers can safely tear down shared provisioning resources. */
export async function concurrentMap<T, U>(items: readonly T[], concurrency: number,
  run: (item: T, index: number) => Promise<U>): Promise<U[]> {
  const results: U[] = new Array(items.length);
  let cursor = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failed && cursor < items.length) {
      const index = cursor++;
      try { results[index] = await run(items[index]!, index); }
      catch (error) { if (!failed) failure = error; failed = true; }
    }
  }));
  if (failed) throw failure;
  return results;
}
