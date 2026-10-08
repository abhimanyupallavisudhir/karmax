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
    expect(output).toContain(`karmax_store_transaction_retries_total{process="gateway"} ${after.retries.retried}`);
    expect(output).toContain(`karmax_store_transaction_retries_exhausted_total{process="gateway"} ${after.retries.exhausted}`);
    expect(output).toContain(`karmax_store_transaction_retries_refused_total{process="gateway"} ${after.retries.unsafe}`);
    expect(output).not.toMatch(/secret-tenant|NaN|Infinity/);
  } finally { await store.close(); metrics.close(); }
});

it('reports heap used and limit for the gateway, the worker child and its workflow thread (RT-35)', () => {
  const metrics = new GatewayMetrics(() => ({ separate: true, heap: { usedBytes: 300, limitBytes: 2048, at: Date.now(), rssBytes: 900,
    workflows: { usedBytes: 40, limitBytes: 1024 }, workflowCache: { cached: 120, limit: 125, shrinks: 1 } } }));
  try {
    const output = metrics.prometheus();
    expect(output).toMatch(/^karmax_heap_used_bytes\{heap="gateway"\} [1-9]\d+$/m);
    expect(output).toMatch(/^karmax_heap_limit_bytes\{heap="gateway"\} [1-9]\d+$/m);
    expect(output).toMatch(/^karmax_process_rss_bytes\{process="gateway"\} [1-9]\d+$/m);
    expect(output).toContain('karmax_heap_used_bytes{heap="worker"} 300\n');
    expect(output).toContain('karmax_heap_limit_bytes{heap="worker"} 2048\n');
    expect(output).toContain('karmax_heap_used_bytes{heap="workflows"} 40\n');
    expect(output).toContain('karmax_heap_limit_bytes{heap="workflows"} 1024\n');
    expect(output).toContain('karmax_process_rss_bytes{process="worker"} 900\n');
    expect(output).toContain('karmax_workflow_cache_workflows 120\n');
    expect(output).toContain('karmax_workflow_cache_limit 125\n');
    expect(output).toContain('karmax_workflow_cache_shrinks_total 1\n');
    // One TYPE line per family, however many heaps report.
    expect(output.match(/# TYPE karmax_heap_used_bytes gauge/g)).toHaveLength(1);
  } finally { metrics.close(); }
});

it('reports an in-process worker as the gateway\'s workflow thread', () => {
  const metrics = new GatewayMetrics(() => ({ separate: false, heap: { usedBytes: 1, limitBytes: 2, at: Date.now(),
    workflows: { usedBytes: 5, limitBytes: 6 }, workflowCache: { cached: 2, limit: 20, shrinks: 0 } } }));
  try {
    const output = metrics.prometheus();
    expect(output).toContain('karmax_heap_used_bytes{heap="workflows"} 5\n');
    expect(output).toContain('karmax_workflow_cache_limit 20\n');
    expect(output).not.toContain('heap="worker"');
  } finally { metrics.close(); }
});

it('omits the worker series when the child has not reported recently', () => {
  const metrics = new GatewayMetrics(() => ({ separate: true, heap: { usedBytes: 300, limitBytes: 2048, at: Date.now() - 120_000,
    workflows: { usedBytes: 40, limitBytes: 1024 } } }));
  try {
    const output = metrics.prometheus();
    expect(output).toContain('karmax_heap_used_bytes{heap="gateway"}');
    expect(output).not.toMatch(/heap="worker"|heap="workflows"|process="worker"/);
    expect(output).not.toContain('karmax_workflow_cache_workflows');
  } finally { metrics.close(); }
});
