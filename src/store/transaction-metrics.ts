import { performance } from 'node:perf_hooks';

/** Store transaction timings for this process, fixed-cardinality and
 * content-free: no lock keys, tables or tenants ever become labels.
 * - `admission`: from `transaction()` to an open transaction (in-process queue
 *   plus pool checkout);
 * - `globalLock` / `entityLock`: waits on the installation-wide lock (kill
 *   switch) and on narrow per-entity locks (`SqlDatabase.lock`);
 * - `duration`: an open transaction, BEGIN to COMMIT/ROLLBACK — how long it
 *   holds its connection and every lock it took. */
export const STORE_BOUNDS = [0.001, 0.005, 0.025, 0.1, 0.25, 1, 2.5, 5, 15] as const;
export type StoreTiming = 'admission' | 'globalLock' | 'entityLock' | 'duration';
export type StoreFailure = 'deadlock' | 'serialization' | 'timeout' | 'other';
export interface StoreHistogram { count: number; sum: number; buckets: number[] }
export interface StoreMetricsSnapshot {
  timings: Record<StoreTiming, StoreHistogram>;
  failures: Record<StoreFailure, number>;
}

const empty = (): StoreHistogram => ({ count: 0, sum: 0, buckets: STORE_BOUNDS.map(() => 0) });
const timings: Record<StoreTiming, StoreHistogram> = { admission: empty(), globalLock: empty(), entityLock: empty(), duration: empty() };
const failures: Record<StoreFailure, number> = { deadlock: 0, serialization: 0, timeout: 0, other: 0 };

export function observeStore(timing: StoreTiming, startedAt: number): void {
  const seconds = Math.max(0, (performance.now() - startedAt) / 1000);
  const sample = timings[timing];
  sample.count++;
  sample.sum += seconds;
  for (let i = 0; i < STORE_BOUNDS.length; i++) if (seconds <= STORE_BOUNDS[i]!) sample.buckets[i]!++;
}

/** Count a transaction the database failed, by SQLSTATE. Errors the
 * application threw to roll back are not database failures. */
export function countStoreFailure(error: unknown): void {
  const { code, name, message } = (error ?? {}) as { code?: unknown; name?: unknown; message?: unknown };
  const timeout = code === '57014' || code === '55P03' || name === 'DatabaseQueueTimeoutError'
    || /timeout exceeded when trying to connect/i.test(String(message ?? ''));
  if (!timeout && !(typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code))) return;
  failures[timeout ? 'timeout' : code === '40P01' ? 'deadlock' : code === '40001' ? 'serialization' : 'other']++;
}

export function storeMetricsSnapshot(): StoreMetricsSnapshot {
  return structuredClone({ timings, failures });
}
