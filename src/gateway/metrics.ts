import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { processMemory, type ProcessMemory } from '../runtime/memory-budget.js';

/** The worker child's last report (absent when it has not answered a
 * heartbeat recently: unknown, not zero), or, when the worker runs in this
 * process, its workflow thread and cache. */
export type MemorySource = () => { worker?: ProcessMemory; inProcess?: Pick<ProcessMemory, 'workflowHeap' | 'workflowCache'> };

const BOUNDS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 10];
type Sample = { count: number; sum: number; errors: number; buckets: number[] };

/** Fixed-cardinality, content-free operational measurements. Route IDs, query
 * strings, credentials, and message content never enter metric labels. */
export class GatewayMetrics {
  private readonly delay = monitorEventLoopDelay({ resolution: 20 });
  private readonly requests = new Map<string, Sample>();
  private active = 0;
  constructor(private readonly memory: MemorySource = () => ({})) { this.delay.enable(); }
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

  prometheus(): string {
    const seconds = (n: number) => Number.isFinite(n) ? n / 1e9 : 0;
    const lines = [
      '# TYPE karmax_http_inflight gauge', `karmax_http_inflight ${this.active}`,
      ...this.memoryLines(),
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
    return lines.join('\n') + '\n';
  }

  /** Heap used/limit per V8 heap (RT-35): what the operator alerts compare.
   * `workflows` is the workflow thread, an isolate with its own limit that
   * holds every cached workflow; `worker` is the worker child's main heap. */
  private memoryLines(): string[] {
    const { worker, inProcess } = this.memory();
    const gateway = processMemory(inProcess);
    const host = worker ?? gateway;
    const heaps: [string, { heapUsed: number; heapLimit: number }][] = [['gateway', gateway],
      ...(worker ? [['worker', worker] as [string, ProcessMemory]] : []),
      ...(host.workflowHeap ? [['workflows', host.workflowHeap] as [string, ProcessMemory]] : [])];
    const processes: [string, ProcessMemory][] = [['gateway', gateway], ...(worker ? [['worker', worker] as [string, ProcessMemory]] : [])];
    const cache = host.workflowCache;
    return [
      '# TYPE karmax_heap_used_bytes gauge', ...heaps.map(([heap, m]) => `karmax_heap_used_bytes{heap="${heap}"} ${m.heapUsed}`),
      '# TYPE karmax_heap_limit_bytes gauge', ...heaps.map(([heap, m]) => `karmax_heap_limit_bytes{heap="${heap}"} ${m.heapLimit}`),
      '# TYPE karmax_process_rss_bytes gauge', ...processes.map(([name, m]) => `karmax_process_rss_bytes{process="${name}"} ${m.rss}`),
      ...(cache ? ['# TYPE karmax_workflow_cache_workflows gauge', `karmax_workflow_cache_workflows ${cache.cached}`,
        '# TYPE karmax_workflow_cache_limit gauge', `karmax_workflow_cache_limit ${cache.limit}`,
        '# TYPE karmax_workflow_cache_shrinks_total counter', `karmax_workflow_cache_shrinks_total ${cache.shrinks}`] : []),
    ];
  }
}
