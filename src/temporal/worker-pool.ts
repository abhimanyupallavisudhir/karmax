import type { WorkflowBundle } from '@temporalio/worker';
import { TemporalConn } from './config.js';
import { ActivityDeps } from '../activities/index.js';
import { makeWorker, workflowCacheSize, WorkerHandle, WorkerStatus } from './worker.js';
import { buildVersionedBundle, ExternalWorkflowRef } from '../packages/bundle.js';
import { governorConfig, governWorkflowCache, type GovernorState } from './heap-governor.js';
import type { ProcessMemory } from '../runtime/memory-budget.js';

/** Let the supervisor restart the service instead of serving without a poller. */
export function terminateOnWorkerFailure(error: unknown): void {
  console.error('  ! Activity worker failed:', error);
  process.kill(process.pid, 'SIGTERM');
}

/**
 * Keeps a worker running for the task queue and can **roll** it to pick up
 * newly-loaded workflow packages without a restart (PLAN-dynamic-repos §21e).
 *
 * You can't hot-patch a live worker's code — a worker instance's bundle is
 * frozen. But workers are stateless pollers over durable server-side history,
 * so refreshing is: build a NEW worker whose bundle is a *superset* (built-ins +
 * every external package still needed), start it, then drain the old one. The
 * service never goes down, and in-flight executions survive because the new
 * worker can replay their pinned code (that superset requirement is enforced
 * upstream by the package retirement guard, §21c). Finite tasks drain on their
 * pinned version; long-lived coordinators are the exception the SPEC calls out
 * (§4.5 — they need Temporal patching, not just a roll).
 */
export class WorkerManager {
  private handle?: WorkerHandle;
  private bundle?: WorkflowBundle;
  private runPromise?: Promise<void>;
  private externals: ExternalWorkflowRef[] = [];
  private refreshing?: Promise<void>;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private draining = new Set<Promise<void>>();
  private stopRequested = false;
  private readonly governor = governorConfig(process.env, workflowCacheSize());
  private cache: GovernorState = { limit: this.governor.configured, highStreak: 0, lastChangeAt: 0 };
  private shrinks = 0;
  private governing = false;
  private governTimer?: NodeJS.Timeout;
  private lastStatus?: WorkerStatus;

  /** Why the live worker stopped, if it did (see `watch`). */
  failure?: unknown;

  constructor(
    private conn: TemporalConn,
    private deps: ActivityDeps = {},
    /** Called once if the live worker's `run()` rejects (connection lost, bundle
     *  runtime error). Without it the gateway kept serving with no poller and
     *  every task stalled silently. */
    private onFailure: (error: unknown) => void = (error) => console.error('[worker] stopped unexpectedly:', error),
  ) {}

  /** `run()` resolves only on shutdown; a rejection means the worker is gone. */
  private watch(handle: WorkerHandle, run: Promise<void>): Promise<void> {
    return run.catch((error) => {
      if (this.handle !== handle) return; // an old worker draining after a refresh
      this.failure = error;
      this.onFailure(error);
    });
  }

  /** Currently-registered external packages (version-qualified). */
  get packages(): ExternalWorkflowRef[] {
    return [...this.externals];
  }

  /** Start the initial worker (built-ins, plus any externals given). */
  async start(externals: ExternalWorkflowRef[] = [], bundle?: WorkflowBundle): Promise<void> {
    if (this.stopRequested) throw new Error('worker manager is stopping');
    if (this.starting || this.handle) throw new Error('worker manager already started');
    this.starting = (async () => {
      this.externals = externals;
      this.handle = await this.build(externals, bundle);
      this.runPromise = this.watch(this.handle, this.handle.run());
      this.governTimer = setInterval(() => void this.govern(), this.governor.checkMs);
      this.governTimer.unref();
    })();
    try { await this.starting; }
    finally { this.starting = undefined; }
  }

  private async build(externals: ExternalWorkflowRef[], prepared?: WorkflowBundle): Promise<WorkerHandle> {
    const workflowBundle = prepared ?? await buildVersionedBundle(externals);
    const handle = await makeWorker(this.conn, { ...this.deps, workflowBundle: () => this.bundle ?? workflowBundle },
      { workflowBundle, shutdownGraceTime: '45 minutes', maxCachedWorkflows: this.cache.limit });
    this.bundle = workflowBundle;
    return handle;
  }

  /**
   * Roll the worker so it also serves `externals` (a superset of what's live).
   * Serialized: overlapping refreshes would race the handle swap. Starts the new
   * worker before draining the old so the queue is never unserved.
   */
  async refresh(externals: ExternalWorkflowRef[], prepared?: WorkflowBundle): Promise<void> {
    if (this.stopRequested) throw new Error('worker manager is stopping');
    // Chain onto any in-progress refresh so swaps stay ordered.
    const run = async () => {
      await this.starting;
      const next = await this.build(externals, prepared);
      const old = this.handle;
      this.handle = next;
      const nextRun = this.watch(next, next.run());
      const oldRun = this.runPromise;
      this.runPromise = nextRun;
      this.externals = externals;
      old?.shutdown(); // graceful drain: stop polling, let in-flight finish
      if (oldRun) {
        this.draining.add(oldRun);
        void oldRun.finally(() => this.draining.delete(oldRun));
      }
    };
    this.refreshing = (this.refreshing ?? Promise.resolve()).then(run, run);
    return this.refreshing;
  }

  /** The live worker's cache and workflow heap as of the last check (RT-35). */
  status(): Pick<ProcessMemory, 'workflowCache' | 'workflowHeap'> {
    const status = this.lastStatus;
    if (!status) return {};
    return { workflowCache: { cached: status.cachedWorkflows, limit: this.cache.limit, shrinks: this.shrinks },
      ...(status.workflowHeap ? { workflowHeap: status.workflowHeap } : {}) };
  }

  /** Shrink the sticky cache when the workflow thread's heap is under
   * sustained pressure, and grow it back after a long calm (heap-governor.ts).
   * The roll reuses the live bundle: no rebuild while memory is short. */
  private async govern(): Promise<void> {
    if (this.governing || this.stopRequested) return;
    this.governing = true;
    try {
      const status = await this.handle?.status();
      if (!status) return;
      this.lastStatus = status;
      if (!status.workflowHeap?.heapLimit) return;
      const previous = this.cache.limit;
      this.cache = governWorkflowCache(this.cache, { ratio: status.workflowHeap.heapUsed / status.workflowHeap.heapLimit,
        cached: status.cachedWorkflows, now: Date.now() }, this.governor);
      if (this.cache.limit === previous) return;
      if (this.cache.limit < previous) this.shrinks++;
      console.warn(`[worker] workflow heap ${Math.round(100 * status.workflowHeap.heapUsed / status.workflowHeap.heapLimit)}% `
        + `of ${Math.round(status.workflowHeap.heapLimit / 2 ** 20)} MiB with ${status.cachedWorkflows} cached workflows: `
        + `${this.cache.limit < previous ? 'shrinking' : 'growing'} the workflow cache from ${previous} to ${this.cache.limit}`);
      await this.refresh(this.externals, this.bundle);
    } catch (error) {
      console.error('[worker] workflow cache governor failed:', error);
    } finally { this.governing = false; }
  }

  async stop(): Promise<void> {
    // Close admission synchronously, before waiting for a build/refresh. Every
    // already-accepted operation must finish before we drain the final handle.
    this.stopRequested = true;
    clearInterval(this.governTimer);
    this.stopping ??= (async () => {
      await this.starting?.catch(() => {});
      await this.refreshing?.catch(() => {});
      this.handle?.shutdown();
      await this.runPromise?.catch(() => {});
      await Promise.allSettled(this.draining);
    })();
    await this.stopping;
  }
}
