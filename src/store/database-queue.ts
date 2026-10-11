import { AsyncResource } from 'node:async_hooks';
import { DatabaseCapacityError, DatabaseQueueTimeoutError } from './async-sql.js';

export { DatabaseQueueTimeoutError };

interface Entry {
  start: () => void;
  timer?: NodeJS.Timeout;
}

/** Admits mutation boundaries `concurrency` at a time (one: serialized)
 * without retaining expired requests behind a slow operation. Only waiting
 * work expires: an active write must return its actual commit/rollback result,
 * never an ambiguous admission timeout. */
export class DatabaseQueue {
  private entries: Entry[] = [];
  private active = 0;
  private closing = false;
  private idle: Array<() => void> = [];
  private readonly maxPending: number;
  private readonly waitTimeoutMs: number;
  private readonly concurrency: number;

  constructor(options: { maxPending?: number; waitTimeoutMs?: number; concurrency?: number } = {}) {
    this.maxPending = options.maxPending ?? 256;
    this.waitTimeoutMs = options.waitTimeoutMs ?? 5_000;
    this.concurrency = options.concurrency ?? 1;
    if (!Number.isSafeInteger(this.concurrency) || this.concurrency < 1) throw new Error('database queue concurrency must be a positive integer');
    if (!Number.isSafeInteger(this.maxPending) || this.maxPending < 1
      || !Number.isSafeInteger(this.waitTimeoutMs) || this.waitTimeoutMs < 1 || this.waitTimeoutMs > 2_147_483_647)
      throw new Error('database queue limits must be positive integers within timer bounds');
  }

  get waiting(): number { return this.entries.length; }
  get pending(): number { return this.entries.length + this.active; }

  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('database is closing'));
    if (this.pending >= this.maxPending) return Promise.reject(new DatabaseCapacityError());
    // A queued operation belongs to its caller, not the request that happens
    // to finish before it and pump the queue (auth, timing and transaction ALS).
    const bound = AsyncResource.bind(operation);
    return new Promise<T>((resolve, reject) => {
      const finish = () => { this.active--; this.pump(); };
      const entry: Entry = {
        start: () => {
          void Promise.resolve().then(bound).then(
            value => { finish(); resolve(value); },
            error => { finish(); reject(error); },
          );
        },
      };
      this.entries.push(entry);
      if (this.active >= this.concurrency) {
        entry.timer = setTimeout(() => {
          const index = this.entries.indexOf(entry);
          if (index < 0) return;
          this.entries.splice(index, 1);
          reject(new DatabaseQueueTimeoutError());
        }, this.waitTimeoutMs);
        entry.timer.unref();
      }
      this.pump();
    });
  }

  private pump(): void {
    while (this.active < this.concurrency) {
      const entry = this.entries.shift();
      if (!entry) {
        if (!this.active) for (const resolve of this.idle.splice(0)) resolve();
        return;
      }
      clearTimeout(entry.timer);
      this.active++;
      entry.start();
    }
  }

  /** Stop admission and drain work already accepted, including its deadlines. */
  async close(): Promise<void> {
    this.closing = true;
    if (this.pending) await new Promise<void>(resolve => this.idle.push(resolve));
  }
}
