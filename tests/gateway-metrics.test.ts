import { expect, it } from 'vitest';
import { GatewayMetrics } from '../src/gateway/metrics.js';
import { Store } from '../src/store/db.js';
import { countStoreFailure, storeMetricsSnapshot } from '../src/store/transaction-metrics.js';

it('bounds labels, omits sensitive URL values, and counts completion/abort only once', () => {
  const metrics = new GatewayMetrics();
  try {
    for (let i = 0; i < 500; i++) {
      const end = metrics.begin(`/api/tasks/private-${i}?token=secret-${i}`);
      end(i % 2 ? 200 : 499); end(500);
    }
    const output = metrics.prometheus();
    expect(output).toContain('karmax_http_inflight 0');
    expect(output).toContain('karmax_http_request_duration_seconds_count{route="task"} 500');
    expect(output).toContain('karmax_http_errors_total{route="task"} 250');
    expect(output).not.toMatch(/private-|secret-|NaN|Infinity/);
    // HTTP routes plus the fixed block of Store timings for two processes.
    expect(output.length).toBeLessThan(10_000);
  } finally { metrics.close(); }
});

it('times Store transactions and lock waits per process without naming what was locked', async () => {
  const metrics = new GatewayMetrics();
  const store = await Store.create(':memory:');
  try {
    const before = storeMetricsSnapshot();
    await store.transaction(async () => { await store.lock('org:secret-tenant'); await store.kvSet('k', 'v'); });
    countStoreFailure(Object.assign(new Error('deadlock detected'), { code: '40P01' }));
    countStoreFailure(new Error('an application refusal is not a database failure'));
    const after = storeMetricsSnapshot();
    expect(after.timings.duration.count).toBeGreaterThan(before.timings.duration.count);
    expect(after.timings.admission.count).toBeGreaterThan(before.timings.admission.count);
    expect(after.failures.deadlock).toBe(before.failures.deadlock + 1);
    expect(after.failures.other).toBe(before.failures.other);
    const worker = structuredClone(after);
    worker.timings.globalLock.count = 7;
    const output = metrics.prometheus(worker);
    expect(output).toContain(`karmax_store_transaction_seconds_count{process="gateway"} ${after.timings.duration.count}`);
    expect(output).toContain('karmax_store_global_lock_wait_seconds_count{process="worker"} 7');
    expect(output).toMatch(/karmax_store_entity_lock_wait_seconds_bucket\{process="gateway",le="0\.001"\} \d+/);
    expect(output).toContain(`karmax_store_transaction_failures_total{process="gateway",reason="deadlock"} ${after.failures.deadlock}`);
    expect(output).not.toMatch(/secret-tenant|NaN|Infinity/);
  } finally { await store.close(); metrics.close(); }
});
