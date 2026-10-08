import { fork, type ChildProcess } from 'node:child_process';
import v8 from 'node:v8';
import type { ExternalWorkflowRef } from '../packages/bundle.js';
import type { WorkflowCacheStatus } from '../runtime/memory-budget.js';

export interface WorkerProcessRequest {
  type: 'worker.request'; id: number; action: 'start' | 'refresh' | 'stop' | 'ping';
  packages?: ExternalWorkflowRef[];
}
export interface WorkerProcessReply {
  type: 'worker.reply'; id: number; ok: boolean; error?: string;
  /** On a ping: the worker's heaps, for metrics and the service-limits page. */
  heap?: WorkerHeap;
}
/** V8 heap in use against its limit (`--max-old-space-size`, from the memory
 * budget), and, where the worker runs, its workflow thread's separate heap and
 * sticky cache (RT-35). */
export interface WorkerHeap {
  usedBytes: number; limitBytes: number; at: number;
  rssBytes?: number;
  workflows?: { usedBytes: number; limitBytes: number };
  workflowCache?: WorkflowCacheStatus;
}
export function heapNow(worker: Pick<WorkerHeap, 'workflows' | 'workflowCache'> = {}): WorkerHeap {
  const heap = v8.getHeapStatistics();
  return { usedBytes: heap.used_heap_size, limitBytes: heap.heap_size_limit, at: Date.now(),
    rssBytes: process.memoryUsage.rss(), ...worker };
}
/** A child's reported heap, numbers only, stamped on this clock. Fields an
 * older child does not send stay absent. */
function workerHeapFrom(heap: WorkerHeap): WorkerHeap {
  const finite = (...values: unknown[]) => values.every((value) => typeof value === 'number' && Number.isFinite(value));
  const { workflows, workflowCache, rssBytes } = heap;
  return { usedBytes: heap.usedBytes, limitBytes: heap.limitBytes, at: Date.now(),
    ...(finite(rssBytes) ? { rssBytes } : {}),
    ...(workflows && finite(workflows.usedBytes, workflows.limitBytes)
      ? { workflows: { usedBytes: workflows.usedBytes, limitBytes: workflows.limitBytes } } : {}),
    ...(workflowCache && finite(workflowCache.cached, workflowCache.limit, workflowCache.shrinks)
      ? { workflowCache: { cached: workflowCache.cached, limit: workflowCache.limit, shrinks: workflowCache.shrinks } } : {}) };
}
/** Unsolicited child → supervisor hint: events were committed to the shared store. */
export interface WorkerProcessNotice { type: 'worker.events' }

/** One supervised child, with bounded control requests and explicit readiness.
 * A control timeout kills the child: the caller cannot safely assume a timed-out
 * refresh never activated. Recovery must launch a new controller after this one
 * has stopped; this class never silently starts a second poller.
 *
 * The entrypoint is trusted application code, not a user-supplied executable.
 * It must drain on stop/disconnect and implement the matching control protocol.
 */
export class WorkerProcessManager {
  private child?: ChildProcess;
  private exited?: Promise<void>;
  private stopping?: Promise<void>;
  private stopRequested = false;
  private started = false;
  private ready = false;
  private serial = 0;
  private queuedRefreshes = 0;
  private refreshing: Promise<void> = Promise.resolve();
  private heartbeat?: NodeJS.Timeout;
  private externals: ExternalWorkflowRef[] = [];
  private pending = new Map<number, { resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  failure?: Error;
  /** The child's heap as of its last heartbeat. */
  heap?: WorkerHeap;

  constructor(private options: {
    entrypoint: string;
    env?: NodeJS.ProcessEnv;
    execArgv?: string[];
    requestTimeoutMs?: number;
    stopTimeoutMs?: number;
    heartbeatIntervalMs?: number;
    heartbeatTimeoutMs?: number;
    onFailure?: (error: Error) => void;
    /** The child committed events; a relay can deliver them now (LT-15). */
    onEvents?: () => void;
  }) {
    for (const value of [options.requestTimeoutMs, options.stopTimeoutMs,
      options.heartbeatIntervalMs, options.heartbeatTimeoutMs])
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647))
        throw new Error('worker timeouts must be positive timer durations');
  }

  get packages(): ExternalWorkflowRef[] { return structuredClone(this.externals); }
  get isReady(): boolean { return this.ready && !this.stopRequested && !this.failure; }

  private fail(error: Error): void {
    clearInterval(this.heartbeat);
    this.ready = false;
    if (!this.failure) {
      this.failure = error;
      try { this.options.onFailure?.(error); } catch { /* diagnostics cannot prevent cleanup */ }
    }
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  private terminate(error: Error): void {
    this.fail(error);
    this.child?.kill('SIGKILL');
  }

  private request(action: WorkerProcessRequest['action'], packages?: ExternalWorkflowRef[], timeoutMs?: number): Promise<void> {
    if (!this.child?.connected || this.failure) return Promise.reject(this.failure ?? new Error('worker process is unavailable'));
    if (this.pending.size >= 16) return Promise.reject(new Error('worker control admission is full'));
    const id = ++this.serial;
    const request: WorkerProcessRequest = { type: 'worker.request', id, action, ...(packages ? { packages } : {}) };
    if (Buffer.byteLength(JSON.stringify(request)) > 1024 * 1024)
      return Promise.reject(new Error('worker control request is too large'));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.terminate(new Error(`worker ${action} timed out`)),
        timeoutMs ?? this.options.requestTimeoutMs ?? 60_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.send(request, error => { if (error) this.terminate(new Error('worker control send failed')); });
    });
  }

  async start(packages: ExternalWorkflowRef[] = []): Promise<void> {
    if (this.stopRequested || this.started) throw new Error('worker process cannot be started again');
    this.started = true;
    const snapshot = structuredClone(packages);
    try {
      const child = fork(this.options.entrypoint, [], {
        env: this.options.env ?? process.env,
        execArgv: this.options.execArgv ?? ['--import', 'tsx'],
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      this.child = child;
      this.exited = new Promise<void>(resolve => {
        child.once('close', (code, signal) => {
          this.ready = false;
          if (!this.stopRequested || this.pending.size || code !== 0 || signal)
            this.fail(new Error('worker process exited before completing its accepted work'));
          resolve();
        });
      });
      child.once('error', () => this.terminate(new Error('worker process could not start')));
      child.once('disconnect', () => {
        if (!this.stopRequested) this.terminate(new Error('worker control channel disconnected'));
      });
      child.on('message', (value: unknown) => {
        if (!value || typeof value !== 'object') return;
        if ((value as Partial<WorkerProcessNotice>).type === 'worker.events') {
          try { this.options.onEvents?.(); } catch { /* a hint; polling still delivers */ }
          return;
        }
        const reply = value as Partial<WorkerProcessReply>;
        if (reply.type !== 'worker.reply' || typeof reply.id !== 'number' || typeof reply.ok !== 'boolean') return;
        if (reply.heap && Number.isFinite(reply.heap.usedBytes) && Number.isFinite(reply.heap.limitBytes))
          this.heap = workerHeapFrom(reply.heap);
        const request = this.pending.get(reply.id);
        if (!request) return;
        this.pending.delete(reply.id);
        clearTimeout(request.timer);
        if (reply.ok) request.resolve();
        else request.reject(new Error(typeof reply.error === 'string' ? reply.error.slice(0, 2_000) : 'worker request failed'));
      });
      await this.request('start', snapshot);
      this.externals = snapshot;
      this.ready = !this.stopRequested;
      if (this.ready) {
        this.heartbeat = setInterval(() => {
          // Accepted control work already has a deadline. Do not mistake a
          // legitimate bundle refresh for an unresponsive idle event loop.
          if (!this.isReady || this.pending.size || this.queuedRefreshes) return;
          void this.request('ping', undefined, this.options.heartbeatTimeoutMs ?? 15_000).catch(error => {
            if (!this.stopRequested && !this.failure) this.terminate(error);
          });
        }, this.options.heartbeatIntervalMs ?? 10_000);
        this.heartbeat.unref();
      }
    } catch (error) {
      this.terminate(error instanceof Error ? error : new Error('worker startup failed'));
      await this.exited;
      throw error;
    }
  }

  async refresh(packages: ExternalWorkflowRef[]): Promise<void> {
    if (!this.isReady) throw this.failure ?? new Error('worker process is not accepting refreshes');
    if (this.queuedRefreshes >= 16) throw new Error('worker refresh admission is full');
    if (Buffer.byteLength(JSON.stringify(packages)) > 1024 * 1024) throw new Error('worker control request is too large');
    // Snapshot the request before queuing it; later caller mutation cannot
    // change which immutable package revisions this refresh activates.
    const snapshot = structuredClone(packages);
    this.queuedRefreshes++;
    const work = async () => {
      await this.request('refresh', snapshot);
      this.externals = snapshot;
    };
    const accepted = this.refreshing.then(work, work).finally(() => { this.queuedRefreshes--; });
    this.refreshing = accepted.catch(() => {});
    return accepted;
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    clearInterval(this.heartbeat);
    this.ready = false;
    this.stopping ??= (async () => {
      if (!this.child) return;
      // The stop deadline also covers an accepted refresh that is hung. The
      // final kill and process exit are awaited before the supervisor returns.
      const timer = setTimeout(() => this.terminate(new Error('worker shutdown timed out')),
        this.options.stopTimeoutMs ?? 3_500);
      try {
        await this.refreshing;
        if (this.child.connected && !this.failure)
          await this.request('stop', undefined, this.options.stopTimeoutMs ?? 3_500).catch(() => {});
        await this.exited;
      } finally { clearTimeout(timer); }
    })();
    await this.stopping;
  }
}
