import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { STORE_BOUNDS, storeMetricsSnapshot, type StoreMetricsSnapshot } from '../store/transaction-metrics.js';

const BOUNDS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 10];
type Sample = { count: number; sum: number; errors: number; buckets: number[] };

/** Fixed-cardinality, content-free operational measurements. Route IDs, query
 * strings, credentials, and message content never enter metric labels. */
export class GatewayMetrics {
  private readonly delay = monitorEventLoopDelay({ resolution: 20 });
  private readonly requests = new Map<string, Sample>();
  private active = 0;
  constructor() { this.delay.enable(); }
  close(): void { this.delay.disable(); }

  begin(url: string): (status: number) => void {
    const route = url.split('?')[0] ?? '';
    const category = /^\/api\/projects\/[^/]+\/tasks$/.test(route) ? 'task_list'
      : /^\/api\/projects\/[^/]+\/search$/.test(route) ? 'search'
      : /^\/api\/tasks\//.test(route) ? 'task'
      : /^\/api\/auth\//.test(route) ? 'auth'
      : route.startsWith('/api/') ? 'other_api' : 'other';
    const start = performance.now();
    this.active++;
    let finished = false;
    return status => {
      if (finished) return;
      finished = true;
      this.active--;
      const seconds = (performance.now() - start) / 1000;
      const sample = this.requests.get(category) ?? { count: 0, sum: 0, errors: 0, buckets: BOUNDS.map(() => 0) };
      sample.count++;
      sample.sum += seconds;
      if (status >= 500 || status === 499) sample.errors++;
      for (let i = 0; i < BOUNDS.length; i++) if (seconds <= BOUNDS[i]!) sample.buckets[i] = sample.buckets[i]! + 1;
      this.requests.set(category, sample);
    };
  }

  /** `worker` is the supervised activity child's latest Store snapshot. */
  prometheus(worker?: StoreMetricsSnapshot): string {
    const seconds = (n: number) => Number.isFinite(n) ? n / 1e9 : 0;
    const lines = [
      '# TYPE karmax_http_inflight gauge', `karmax_http_inflight ${this.active}`,
      '# TYPE karmax_process_rss_bytes gauge', `karmax_process_rss_bytes ${process.memoryUsage().rss}`,
      '# TYPE karmax_event_loop_delay_seconds gauge',
      `karmax_event_loop_delay_seconds{quantile="0.95"} ${seconds(this.delay.percentile(95))}`,
      `karmax_event_loop_delay_seconds{quantile="0.99"} ${seconds(this.delay.percentile(99))}`,
      '# TYPE karmax_event_loop_delay_max_seconds gauge',
      `karmax_event_loop_delay_max_seconds ${seconds(this.delay.max)}`,
      '# TYPE karmax_http_request_duration_seconds histogram',
      '# TYPE karmax_http_errors_total counter',
    ];
    for (const [route, sample] of this.requests) {
      for (let i = 0; i < BOUNDS.length; i++)
        lines.push(`karmax_http_request_duration_seconds_bucket{route="${route}",le="${BOUNDS[i]}"} ${sample.buckets[i]}`);
      lines.push(`karmax_http_request_duration_seconds_bucket{route="${route}",le="+Inf"} ${sample.count}`,
        `karmax_http_request_duration_seconds_count{route="${route}"} ${sample.count}`,
        `karmax_http_request_duration_seconds_sum{route="${route}"} ${sample.sum}`,
        `karmax_http_errors_total{route="${route}"} ${sample.errors}`);
    }
    lines.push(...storeLines({ gateway: storeMetricsSnapshot(), ...(worker ? { worker } : {}) }));
    return lines.join('\n') + '\n';
  }
}

const STORE_HISTOGRAMS = {
  admission: 'karmax_store_transaction_admission_seconds',
  globalLock: 'karmax_store_global_lock_wait_seconds',
  entityLock: 'karmax_store_entity_lock_wait_seconds',
  duration: 'karmax_store_transaction_seconds',
} as const;

/** Store transaction timings per process (`gateway`, `worker`). */
function storeLines(processes: Record<string, StoreMetricsSnapshot>): string[] {
  const lines: string[] = [];
  for (const [timing, name] of Object.entries(STORE_HISTOGRAMS) as Array<[keyof typeof STORE_HISTOGRAMS, string]>) {
    lines.push(`# TYPE ${name} histogram`);
    for (const [process, snapshot] of Object.entries(processes)) {
      const sample = snapshot.timings[timing];
      for (let i = 0; i < STORE_BOUNDS.length; i++)
        lines.push(`${name}_bucket{process="${process}",le="${STORE_BOUNDS[i]}"} ${sample.buckets[i]}`);
      lines.push(`${name}_bucket{process="${process}",le="+Inf"} ${sample.count}`,
        `${name}_count{process="${process}"} ${sample.count}`, `${name}_sum{process="${process}"} ${sample.sum}`);
    }
  }
  lines.push('# TYPE karmax_store_transaction_failures_total counter');
  for (const [process, snapshot] of Object.entries(processes))
    for (const [reason, count] of Object.entries(snapshot.failures))
      lines.push(`karmax_store_transaction_failures_total{process="${process}",reason="${reason}"} ${count}`);
  return lines;
}
