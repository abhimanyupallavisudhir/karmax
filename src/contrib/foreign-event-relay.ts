import { setImmediate as yieldTurn } from 'node:timers/promises';
import type { Store } from '../store/db.js';
import type { KarmaxBus } from './bus.js';
import { AsyncInterval } from '../util/async-interval.js';

/** Delivers other processes' committed events to this process's subscribers.
 * IPC may wake the relay, but event payloads always come from the database.
 * One bounded page is retained while consumers run; slow consumers do not
 * create an unbounded in-memory event queue. Local events are not redelivered.
 *
 * Pages end at the event watermark (`Store.eventWatermark`): seqs are not
 * commit-ordered across concurrent transactions, and a cursor that read past
 * one still to commit would never relay it (a worker's `view.updated`, so
 * browsers kept showing the old task state until a reload).
 *
 * The cursor belongs to this running gateway, not a durable consumer identity:
 * restart recovery still belongs to subscribers (e.g. trigger rearming). Capture
 * it before starting workers, then start polling after subscribers are installed.
 */
export class ForeignEventRelay {
  private stopping = false;
  private readonly interval: AsyncInterval;
  private constructor(private store: Pick<Store, 'nextForeignEventPage'>, private bus: KarmaxBus,
    private cursor: number, intervalMs: number, onError?: (error: unknown) => void) {
    this.interval = new AsyncInterval(() => this.drain(), intervalMs, onError).unref();
  }

  static async create(store: Pick<Store, 'nextForeignEventPage' | 'latestEventSeq'>, bus: KarmaxBus,
    options: { cursor?: number; intervalMs?: number; onError?: (error: unknown) => void } = {}) {
    const cursor = options.cursor ?? await store.latestEventSeq();
    return new ForeignEventRelay(store, bus, cursor, options.intervalMs ?? 500, options.onError);
  }

  /** Coalesced wake-up; a wake during a drain drains again right after it.
   * Polling remains the recovery path for a lost wake-up. */
  wake(): Promise<void> { return this.interval.wake(); }

  private async drain(): Promise<void> {
    do {
      const page = await this.store.nextForeignEventPage(this.cursor, 128);
      for (const event of page.events) await this.bus.emit(event);
      this.cursor = page.cursor;
      if (page.scanned < 128 || this.stopping) break;
      await yieldTurn();
    } while (!this.stopping);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.interval.stop();
  }
}
