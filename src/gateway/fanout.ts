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
 *
 * Subscribers name the organizations whose events they may read, and an event
 * is offered only to its organization's subscribers and to installation-wide
 * readers ('all'), each in event order. Offering every tenant's events to every
 * socket made each decide, per event, about tenants it could never read: the
 * 2026-10 load test's first wall (benchmarks/results/load-report-2026-10.md).
 * An organization is a routing bound, not a decision: subscribers still decide
 * each event they are offered. An event whose task has no project reaches only
 * installation-wide readers.
 */
type RoutedEvent = { event: KarmaxEvent & { seq?: number }; projectId?: string; siblingAttempt?: boolean; bytes: number };
export type FanoutAudience = ReadonlySet<string> | 'all';
interface Subscriber {
  listener: (event: KarmaxEvent & { seq?: number }, projectId?: string, siblingAttempt?: boolean) => unknown;
  overflow?: () => void;
  audience: FanoutAudience;
  queue: RoutedEvent[];
  bytes: number;
  running: boolean;
  closed: boolean;
}
/** Unsubscribes when called; `audience` changes the organizations it is offered. */
export type FanoutSubscription = (() => void) & { audience(organizations: FanoutAudience): void };

export class DurableEventFanout {
  private everyone = new Set<Subscriber>();
  private byOrganization = new Map<string, Set<Subscriber>>();
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

  on(listener: Subscriber['listener'], overflow?: () => void, audience: FanoutAudience = 'all'): FanoutSubscription {
    const subscriber: Subscriber = { listener, overflow, audience: 'all', queue: [], bytes: 0, running: false, closed: false };
    this.index(subscriber, audience);
    return Object.assign(() => this.remove(subscriber), {
      audience: (organizations: FanoutAudience) => { if (!subscriber.closed) this.index(subscriber, organizations); },
    });
  }

  /** Every subscriber once, whichever organizations it reads. */
  *subscribers(): Iterable<Readonly<Subscriber>> {
    const seen = new Set<Subscriber>();
    for (const subscriber of [...this.everyone, ...[...this.byOrganization.values()].flatMap((set) => [...set])])
      if (!seen.has(subscriber)) { seen.add(subscriber); yield subscriber; }
  }

  private index(subscriber: Subscriber, audience: FanoutAudience): void {
    this.unindex(subscriber);
    subscriber.audience = audience === 'all' ? 'all' : new Set(audience);
    if (subscriber.audience === 'all') { this.everyone.add(subscriber); return; }
    for (const organizationId of subscriber.audience) {
      let subscribers = this.byOrganization.get(organizationId);
      if (!subscribers) this.byOrganization.set(organizationId, subscribers = new Set());
      subscribers.add(subscriber);
    }
  }

  private unindex(subscriber: Subscriber): void {
    if (subscriber.audience === 'all') { this.everyone.delete(subscriber); return; }
    for (const organizationId of subscriber.audience) {
      const subscribers = this.byOrganization.get(organizationId);
      subscribers?.delete(subscriber);
      if (subscribers && !subscribers.size) this.byOrganization.delete(organizationId);
    }
  }

  private remove(subscriber: Subscriber): void {
    subscriber.closed = true;
    subscriber.queue = [];
    subscriber.bytes = 0;
    this.unindex(subscriber);
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
    for (const subscriber of this.subscribers()) this.remove(subscriber as Subscriber);
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
      for (const subscriber of this.everyone) this.deliver(subscriber, routed);
      const organization = route ? this.byOrganization.get(route.organizationId) : undefined;
      if (organization) for (const subscriber of organization) this.deliver(subscriber, routed);
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
