import { TemporalConn } from './config.js';
import { ActivityDeps } from '../activities/index.js';
import { makeWorker, WorkerHandle } from './worker.js';
import { buildVersionedBundle, ExternalWorkflowRef } from '../packages/bundle.js';

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
  private runPromise?: Promise<void>;
  private externals: ExternalWorkflowRef[] = [];
  private refreshing?: Promise<void>;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private stopRequested = false;

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
  async start(externals: ExternalWorkflowRef[] = []): Promise<void> {
    if (this.stopRequested) throw new Error('worker manager is stopping');
    if (this.starting || this.handle) throw new Error('worker manager already started');
    this.starting = (async () => {
      this.externals = externals;
      this.handle = await this.build(externals);
      this.runPromise = this.watch(this.handle, this.handle.run());
    })();
    try { await this.starting; }
    finally { this.starting = undefined; }
  }

  private async build(externals: ExternalWorkflowRef[]): Promise<WorkerHandle> {
    const opts = externals.length ? { workflowBundle: await buildVersionedBundle(externals) } : {};
    return makeWorker(this.conn, this.deps, opts);
  }

  /**
   * Roll the worker so it also serves `externals` (a superset of what's live).
   * Serialized: overlapping refreshes would race the handle swap. Starts the new
   * worker before draining the old so the queue is never unserved.
   */
  async refresh(externals: ExternalWorkflowRef[]): Promise<void> {
    if (this.stopRequested) throw new Error('worker manager is stopping');
    // Chain onto any in-progress refresh so swaps stay ordered.
    const run = async () => {
      await this.starting;
      const next = await this.build(externals);
      const old = this.handle;
      this.handle = next;
      const nextRun = this.watch(next, next.run());
      const oldRun = this.runPromise;
      this.runPromise = nextRun;
      this.externals = externals;
      old?.shutdown(); // graceful drain: stop polling, let in-flight finish
      await oldRun?.catch(() => {});
    };
    this.refreshing = (this.refreshing ?? Promise.resolve()).then(run, run);
    return this.refreshing;
  }

  async stop(): Promise<void> {
    // Close admission synchronously, before waiting for a build/refresh. Every
    // already-accepted operation must finish before we drain the final handle.
    this.stopRequested = true;
    this.stopping ??= (async () => {
      await this.starting?.catch(() => {});
      await this.refreshing?.catch(() => {});
      this.handle?.shutdown();
      await this.runPromise?.catch(() => {});
    })();
    await this.stopping;
  }
}
