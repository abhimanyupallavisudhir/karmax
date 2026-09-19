import type { Store } from '../store/db.js';
import type { KarmaxEvent } from '../domain/types.js';
import type { KarmaxBus } from '../contrib/bus.js';
import { setImmediate as yieldTurn } from 'node:timers/promises';

/**
 * Durable gateway fan-out. The event table, not an in-process emitter, is the
 * cursor source, so another worker/gateway replica can append an event and all
 * connected browsers still observe it. The local bus only wakes the poller to
 * reduce latency; correctness comes from monotonically increasing event.seq.
 */
export class DurableEventFanout {
  private listeners = new Set<(event: KarmaxEvent & { seq?: number }, projectId?: string) => void>();
  private cursor: number;
  private timer: NodeJS.Timeout;
  private offBus?: () => void;
  private draining = false;
  private closed = false;
  private scheduled?: NodeJS.Immediate;

  constructor(private store: Store, bus?: KarmaxBus, intervalMs = 500) {
    // This used to call allEventsSince(0).at(-1), parsing the entire append-only
    // event log just to learn one integer. On a real karmax home that is tens of
    // MiB of JSON and hundreds of MiB of short-lived objects at every boot.
    this.cursor = store.latestEventSeq();
    this.timer = setInterval(() => this.schedule(), intervalMs);
    this.timer.unref();
    this.offBus = bus?.onAny(() => this.schedule());
  }

  on(listener: (event: KarmaxEvent & { seq?: number }, projectId?: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.closed = true;
    if (this.scheduled) clearImmediate(this.scheduled);
    clearInterval(this.timer);
    this.offBus?.();
    this.listeners.clear();
  }

  private schedule(): void {
    if (this.closed || this.scheduled || this.draining) return;
    this.scheduled = setImmediate(() => {
      this.scheduled = undefined;
      void this.drain().catch(error => console.error('[fanout] delivery failed:', error));
    });
  }

  private async drain(): Promise<void> {
    if (this.draining || this.closed) return;
    this.draining = true;
    try {
      while (!this.closed) {
        // Consume the oldest page after the cursor. allEventsSince(..., limit)
        // intentionally returns the newest page for activity/history views; using
        // it here would skip the middle of bursts larger than one page.
        const rows = await this.store.nextEventsSince(this.cursor, 500);
        if (!rows.length) break;
        const projects = await this.store.taskProjectIds(rows.map(row => row.taskId));
        for (const event of rows) {
          if (this.closed) break;
          this.cursor = Math.max(this.cursor, event.seq ?? 0);
          for (const listener of this.listeners) {
            try { listener(event, projects.get(event.taskId)); }
            catch (error) { console.error('[fanout] subscriber failed:', error); }
          }
        }
        if (rows.length < 500) break;
        await yieldTurn();
      }
    } finally {
      this.draining = false;
    }
  }
}
