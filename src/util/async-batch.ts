/** Bound remote request fan-out and settle the entire active batch on failure.
 * Callers may then release temporary files or credentials without orphaned I/O. */
export async function mapBatches<T, R>(items: T[], run: (item: T) => Promise<R>, concurrency = 8): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32)
    throw new Error('Invalid remote request concurrency');
  const out: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const settled = await Promise.allSettled(items.slice(i, i + concurrency).map(item => Promise.resolve().then(() => run(item))));
    const failed = settled.find(value => value.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    for (const value of settled) if (value.status === 'fulfilled') out.push(value.value);
  }
  return out;
}
