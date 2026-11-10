/**
 * How long world setup may take. Everything but restoring the project's data
 * (allocating a machine, provisioning it, cloning, setup hooks) gets
 * {@link SETUP_BUDGET_MS} in all; restoring data takes as long as it keeps
 * moving, since its time grows with the data, and fails once it has made no
 * progress for {@link RESTORE_STALL_MS}.
 *
 * pramana #191/#192 (2026-11-09): a sub-task's 31 GB, 1.2M-file copy of its
 * parent's raw_data restored at ~20 MB/s into a Fly volume, about as long as
 * the 30 minutes `createWorld` had for everything. Every attempt timed out
 * restoring, threw its machine away with what it had restored, and started
 * over: 18 attempts, 9 hours, then "Activity task timed out" to a person.
 */
export const SETUP_BUDGET_MS = 30 * 60_000;
/** A restore that has not moved for this long is stuck, not slow. */
export const RESTORE_STALL_MS = 10 * 60_000;

/** The work that may run off the clock, told when it moves. */
export interface SetupTime {
  /** Run `work` (restoring data) off the setup budget: it may take as long as
   * it calls `progress` at least every {@link RESTORE_STALL_MS}. */
  offClock<T>(work: (progress: () => void) => Promise<T>): Promise<T>;
}

/** Setup ran out of time, or a restore stopped moving. Infrastructure: a retry may fare better. */
export class SetupTimeout extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetupTimeout';
  }
}

const minutes = (ms: number) => `${Math.round(ms / 60_000)} minutes`;

export class SetupClock implements SetupTime {
  private readonly controller = new AbortController();
  private readonly now: () => number;
  private readonly started: number;
  private deadline: number;
  private restoring = 0;
  private pausedAt = 0;
  private lastProgress = 0;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly onParentAbort = () => this.controller.abort(this.parent!.reason);

  constructor(private readonly options: { budgetMs?: number; stallMs?: number; parent?: AbortSignal; now?: () => number; tickMs?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.started = this.now();
    this.deadline = this.started + this.budgetMs;
    if (this.parent?.aborted) this.onParentAbort();
    else this.parent?.addEventListener('abort', this.onParentAbort, { once: true });
    this.timer = setInterval(() => this.check(), options.tickMs ?? 1_000);
    this.timer.unref?.();
  }

  private get parent() { return this.options.parent; }
  private get budgetMs() { return this.options.budgetMs ?? SETUP_BUDGET_MS; }
  private get stallMs() { return this.options.stallMs ?? RESTORE_STALL_MS; }

  /** Aborts when the budget is spent, a restore stalls, or the parent (the activity) is cancelled. */
  get signal(): AbortSignal { return this.controller.signal; }

  /** The clock's own failure, once it has expired. */
  get expired(): SetupTimeout | undefined {
    return this.controller.signal.reason instanceof SetupTimeout ? this.controller.signal.reason : undefined;
  }

  /** When a wait for a machine must give up: half the budget, as when the
   * activity's own start-to-close was the budget (machine-wait.ts
   * leaseWaitDeadline), so the work after admission still fits. */
  get leaseWaitUntil(): number { return this.started + Math.floor(this.budgetMs / 2); }

  check(): void {
    if (this.controller.signal.aborted) return;
    const now = this.now();
    if (this.restoring > 0) {
      if (now - this.lastProgress >= this.stallMs)
        this.expire(`restoring the project's data made no progress for ${minutes(this.stallMs)}`);
    } else if (now >= this.deadline) {
      this.expire(`world setup took longer than ${minutes(this.budgetMs)} (not counting restoring the project's data)`);
    }
  }

  async offClock<T>(work: (progress: () => void) => Promise<T>): Promise<T> {
    const now = this.now();
    if (this.restoring++ === 0) this.pausedAt = now;
    this.lastProgress = now;
    try {
      return await work(() => { this.lastProgress = this.now(); });
    } finally {
      if (--this.restoring === 0) this.deadline += this.now() - this.pausedAt;
    }
  }

  /** `work`, or the clock's failure as soon as it expires, whether or not
   * `work` notices: as Temporal's own timeout abandoned an attempt. */
  bound<T>(work: Promise<T>): Promise<T> {
    const signal = this.controller.signal;
    return new Promise<T>((resolve, reject) => {
      const expired = () => { if (signal.reason instanceof SetupTimeout) reject(signal.reason); };
      if (signal.aborted) expired();
      signal.addEventListener('abort', expired, { once: true });
      work.then(resolve, reject).finally(() => signal.removeEventListener('abort', expired));
    });
  }

  dispose(): void {
    clearInterval(this.timer);
    this.parent?.removeEventListener('abort', this.onParentAbort);
  }

  private expire(message: string): void {
    this.controller.abort(new SetupTimeout(message));
  }
}
