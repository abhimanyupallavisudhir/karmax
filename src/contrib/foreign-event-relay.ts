import { setImmediate as yieldTurn } from 'node:timers/promises';
import type { Store } from '../store/db.js';
import type { KarmaxBus } from './bus.js';
import { AsyncInterval } from '../util/async-interval.js';

/** How long a skipped seq may still commit. PostgreSQL assigns a seq at insert,
 * not at commit, so an open transaction's row can appear below rows already
 * read; a rolled-back or deleted row never appears, so the wait is bounded. */
const GAP_GRACE_MS = 60_000;
/** Bounds the gap set if a large range of rows is deleted under the cursor. */
const MAX_GAPS = 4096;
const GAP_QUERY_BATCH = 500;

/** Delivers other processes' committed events to this process's subscribers.
 * IPC may wake the relay, but event payloads always come from the database.
 * One bounded page is retained while consumers run; slow consumers do not
 * create an unbounded in-memory event queue. Local events are not redelivered.
 *
 * Seqs are not commit-ordered across concurrent transactions, so every seq the
 * cursor passes without a row is a gap that is re-read until its row commits
 * or GAP_GRACE_MS passes. Without that a worker's `view.updated` that committed
 * just after a later event was never relayed, and browsers kept showing the
 * old task state until a reload.
 *
 * The cursor belongs to this running gateway, not a durable consumer identity:
 * restart recovery still belongs to subscribers (e.g. trigger rearming). Capture
 * it before starting workers, then start polling after subscribers are installed.
 */
export class ForeignEventRelay {
  private stopping = false;
  private readonly interval: AsyncInterval;
  /** Skipped seq → when the cursor first passed it. */
  private readonly gaps = new Map<number, number>();
  private constructor(private store: Pick<Store, 'nextForeignEventPage' | 'foreignEventsAt'>, private bus: KarmaxBus,
    private cursor: number, intervalMs: number, onError?: (error: unknown) => void) {
    this.interval = new AsyncInterval(() => this.drain(), intervalMs, onError).unref();
  }

  static async create(store: Pick<Store, 'nextForeignEventPage' | 'foreignEventsAt' | 'latestEventSeq'>, bus: KarmaxBus,
    options: { cursor?: number; intervalMs?: number; onError?: (error: unknown) => void } = {}) {
    const cursor = options.cursor ?? await store.latestEventSeq();
    return new ForeignEventRelay(store, bus, cursor, options.intervalMs ?? 500, options.onError);
  }

  /** Coalesced wake-up; a wake during a drain drains again right after it.
   * Polling remains the recovery path for a lost wake-up. */
  wake(): Promise<void> { return this.interval.wake(); }

  private async drain(): Promise<void> {
    await this.fillGaps();
    do {
      const page = await this.store.nextForeignEventPage(this.cursor, 128);
      for (const event of page.events) await this.bus.emit(event);
      this.noteGaps(page.seqs);
      this.cursor = page.cursor;
      if (page.scanned < 128 || this.stopping) break;
      await yieldTurn();
    } while (!this.stopping);
  }

  private noteGaps(seqs: readonly number[]): void {
    const now = Date.now();
    let previous = this.cursor;
    for (const seq of seqs) {
      for (let gap = previous + 1; gap < seq && this.gaps.size < MAX_GAPS; gap++) this.gaps.set(gap, now);
      previous = seq;
    }
  }

  private async fillGaps(): Promise<void> {
    const now = Date.now();
    for (const [seq, since] of this.gaps) if (now - since > GAP_GRACE_MS) this.gaps.delete(seq);
    const wanted = [...this.gaps.keys()];
    for (let offset = 0; offset < wanted.length && !this.stopping; offset += GAP_QUERY_BATCH) {
      const found = await this.store.foreignEventsAt(wanted.slice(offset, offset + GAP_QUERY_BATCH));
      for (const event of found.events) {
        await this.bus.emit(event);
        this.gaps.delete(event.seq);
      }
      for (const seq of found.seqs) this.gaps.delete(seq);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.interval.stop();
  }
}
