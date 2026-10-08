import type { Store } from '../store/db.js';
import type { KarmaxEvent } from '../domain/types.js';
import type { KarmaxBus } from '../contrib/bus.js';
import { setImmediate as yieldTurn } from 'node:timers/promises';

/**
 * Durable gateway fan-out. The event table, not an in-process emitter, is the
 * cursor source, so another worker/gateway replica can append an event and all
 * connected browsers still observe it. The local bus only wakes the poller to
 * reduce latency. Pages end at the event watermark, so the cursor never passes
 * an event whose transaction is still to commit.
 */
type RoutedEvent = { event: KarmaxEvent & { seq?: number }; projectId?: string; siblingAttempt?: boolean; bytes: number };
interface Subscriber {
  listener: (event: KarmaxEvent & { seq?: number }, projectId?: string, siblingAttempt?: boolean) => unknown;
  overflow?: () => void;
  queue: RoutedEvent[];
  bytes: number;
  running: boolean;
  closed: boolean;
}

export class DurableEventFanout {
  private listeners = new Set<Subscriber>();
  private cursor!: number;
  private timer!: NodeJS.Timeout;
  private offBus?: () => void;
  private draining = false;
  private closed = false;
  private scheduled?: NodeJS.Immediate;

  constructor(private store: Store, bus?: KarmaxBus, intervalMs = 500) {
  }

  static async create(store: Store, bus?: KarmaxBus, intervalMs = 500) {
    const instance = new DurableEventFanout(store, bus, intervalMs);
    await instance.initialize(store, bus, intervalMs);
    return instance;
  }

  private async initialize(store: Store, bus?: KarmaxBus, intervalMs = 500) {

    // This used to call allEventsSince(0).at(-1), parsing the entire append-only
    // event log just to learn one integer. On a real karmax home that is tens of
    // MiB of JSON and hundreds of MiB of short-lived objects at every boot.
    this.cursor = (await store.latestEventSeq());
    this.timer = setInterval(() => this.schedule(), intervalMs);
    this.timer.unref();
    this.offBus = bus?.onAny(() => this.schedule());
  }

  on(listener: Subscriber['listener'], overflow?: () => void): () => void {
    const subscriber: Subscriber = { listener, overflow, queue: [], bytes: 0, running: false, closed: false };
    this.listeners.add(subscriber);
    return () => this.remove(subscriber);
  }

  private remove(subscriber: Subscriber): void {
    subscriber.closed = true;
    subscriber.queue = [];
    subscriber.bytes = 0;
    this.listeners.delete(subscriber);
  }

  private deliver(subscriber: Subscriber, routed: RoutedEvent): void {
    if (subscriber.closed) return;
    // Authorization and timing reads are asynchronous. Bound work waiting on
    // those reads as well as bytes already in the WebSocket's send buffer.
    if (subscriber.queue.length >= 1024 || subscriber.bytes + routed.bytes > 2 * 1024 * 1024) {
      this.remove(subscriber);
      try { subscriber.overflow?.(); } catch { /* already disconnected */ }
      return;
    }
    subscriber.queue.push(routed);
    subscriber.bytes += routed.bytes;
    if (!subscriber.running) this.pump(subscriber);
  }

  private pump(subscriber: Subscriber): void {
    while (!subscriber.closed && subscriber.queue.length) {
      const routed = subscriber.queue.shift()!;
      subscriber.bytes -= routed.bytes;
      try {
        const result = subscriber.listener(routed.event, routed.projectId, routed.siblingAttempt);
        if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
          subscriber.running = true;
          void Promise.resolve(result).catch(error => console.error('[fanout] subscriber failed:', error))
            .finally(() => { subscriber.running = false; this.pump(subscriber); });
          return;
        }
      } catch (error) { console.error('[fanout] subscriber failed:', error); }
    }
  }

  close(): void {
    this.closed = true;
    if (this.scheduled) clearImmediate(this.scheduled);
    clearInterval(this.timer);
    this.offBus?.();
    for (const subscriber of this.listeners) this.remove(subscriber);
  }

  private schedule(): void {
    if (this.closed || this.scheduled || this.draining) return;
    this.scheduled = setImmediate(() => {
      this.scheduled = undefined;
      void this.drain().catch(error => console.error('[fanout] delivery failed:', error));
    });
  }

  private async route(rows: Array<KarmaxEvent & { seq: number }>): Promise<void> {
    if (!rows.length) return;
    const routes = await this.store.taskEventRoutes(rows.map(row => row.taskId));
    for (const event of rows) {
      if (this.closed) break;
      this.cursor = Math.max(this.cursor, event.seq);
      const route = routes.get(event.taskId);
      const routed = { event, projectId: route?.projectId, siblingAttempt: route?.siblingAttempt, bytes: Buffer.byteLength(JSON.stringify(event)) };
      for (const subscriber of this.listeners) this.deliver(subscriber, routed);
    }
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
        await this.route(rows);
        if (rows.length < 500) break;
        await yieldTurn();
      }
    } finally {
      this.draining = false;
    }
  }
}
