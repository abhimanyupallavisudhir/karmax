import { expect, it } from 'vitest';
import { GatewayMetrics } from '../src/gateway/metrics.js';

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
    expect(output.length).toBeLessThan(2500);
  } finally { metrics.close(); }
});

it('reports heap used and limit for the gateway, the worker child and its workflow thread (RT-35)', () => {
  const metrics = new GatewayMetrics(() => ({
    worker: { heapUsed: 300, heapLimit: 2048, rss: 900, workflowHeap: { heapUsed: 40, heapLimit: 1024 },
      workflowCache: { cached: 120, limit: 125, shrinks: 1 } },
  }));
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
  const metrics = new GatewayMetrics(() => ({ inProcess: { workflowHeap: { heapUsed: 5, heapLimit: 6 },
    workflowCache: { cached: 2, limit: 20, shrinks: 0 } } }));
  try {
    const output = metrics.prometheus();
    expect(output).toContain('karmax_heap_used_bytes{heap="workflows"} 5\n');
    expect(output).toContain('karmax_workflow_cache_limit 20\n');
    expect(output).not.toContain('heap="worker"');
  } finally { metrics.close(); }
});

it('omits the worker series when the child has not reported recently', () => {
  const metrics = new GatewayMetrics(() => ({}));
  try {
    const output = metrics.prometheus();
    expect(output).toContain('karmax_heap_used_bytes{heap="gateway"}');
    expect(output).not.toMatch(/heap="worker"|heap="workflows"|process="worker"/);
    expect(output).not.toContain('karmax_workflow_cache_workflows');
  } finally { metrics.close(); }
});
