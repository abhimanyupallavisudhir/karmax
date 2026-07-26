import type { Store } from '../store/db.js';
import type { KarmaxEvent } from '../domain/types.js';
import type { KarmaxBus } from '../contrib/bus.js';

/**
 * Durable gateway fan-out. The event table, not an in-process emitter, is the
 * cursor source, so another worker/gateway replica can append an event and all
 * connected browsers still observe it. The local bus only wakes the poller to
 * reduce latency; correctness comes from monotonically increasing event.seq.
 */
export class DurableEventFanout {
  private listeners = new Set<(event: KarmaxEvent) => void>();
  private cursor: number;
  private timer: NodeJS.Timeout;
  private offBus?: () => void;
  private draining = false;

  constructor(private store: Store, bus?: KarmaxBus, intervalMs = 500) {
    // This used to call allEventsSince(0).at(-1), parsing the entire append-only
    // event log just to learn one integer. On a real karmax home that is tens of
    // MiB of JSON and hundreds of MiB of short-lived objects at every boot.
    this.cursor = store.latestEventSeq();
    this.timer = setInterval(() => void this.drain(), intervalMs);
    this.timer.unref();
    this.offBus = bus?.onAny(() => void this.drain());
  }

  on(listener: (event: KarmaxEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    clearInterval(this.timer);
    this.offBus?.();
    this.listeners.clear();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        // Consume the oldest page after the cursor. allEventsSince(..., limit)
        // intentionally returns the newest page for activity/history views; using
        // it here would skip the middle of bursts larger than one page.
        const rows = this.store.nextEventsSince(this.cursor, 500);
        if (!rows.length) break;
        for (const event of rows) {
          this.cursor = Math.max(this.cursor, event.seq ?? 0);
          for (const listener of this.listeners) listener(event);
        }
        if (rows.length < 500) break;
      }
    } finally {
      this.draining = false;
    }
  }
}
