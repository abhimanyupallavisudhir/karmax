import { EventEmitter } from 'node:events';
import { KarmaxEvent } from '../domain/types.js';

const DELIVERED_WINDOW = 4096;

/**
 * In-process event bus. Activities push typed events here; the gateway streams
 * them to the UI over WebSocket. This is the transport layer (SPEC §3.3) — a
 * router that sits underneath control flow, never the control flow itself.
 */
export class KarmaxBus {
  private ee = new EventEmitter();
  /** Recently delivered event-log sequence numbers, oldest first. */
  private delivered = new Set<number>();
  constructor() {
    this.ee.setMaxListeners(0);
  }
  /**
   * Dispatch to every subscriber, isolating each one.
   *
   * `EventEmitter.emit` calls listeners inline and synchronously, so an
   * exception in one subscriber aborted the whole dispatch: every later
   * subscriber was skipped, and the throw propagated back into whatever
   * *activity* had emitted the event — failing unrelated work because a
   * projection had a bug. The bus is a transport (SPEC §3.3); a broken consumer
   * is that consumer's problem.
   */
  emit(ev: KarmaxEvent & { seq?: number }): Promise<void> {
    // A recorded event can arrive twice: from the writer that recorded it and
    // from the store, which delivers every committed row (Store.onEventRecorded)
    // so that no writer has to remember to. Subscribers see each row once. The
    // window only has to span those two deliveries, microseconds apart.
    if (ev.seq !== undefined) {
      if (this.delivered.has(ev.seq)) return Promise.resolve();
      this.delivered.add(ev.seq);
      if (this.delivered.size > DELIVERED_WINDOW) this.delivered.delete(this.delivered.values().next().value!);
    }
    const pending: Promise<unknown>[] = [];
    for (const channel of ['event', `task:${ev.taskId}`]) {
      for (const listener of this.ee.listeners(channel) as Array<(e: unknown) => unknown>) {
        try {
          const result = listener(ev);
          if (result && typeof (result as PromiseLike<unknown>).then === 'function')
            pending.push(Promise.resolve(result).catch(error => {
              console.error(`[bus] subscriber for "${channel}" failed:`, error);
            }));
        } catch (error) {
          console.error(`[bus] subscriber for "${channel}" threw:`, error instanceof Error ? error.stack ?? error.message : error);
        }
      }
    }
    return Promise.all(pending).then(() => {});
  }
  onAny(fn: (ev: KarmaxEvent & { seq?: number }) => void): () => void {
    this.ee.on('event', fn);
    return () => this.ee.off('event', fn);
  }
  onTask(taskId: string, fn: (ev: KarmaxEvent & { seq?: number }) => void): () => void {
    this.ee.on(`task:${taskId}`, fn);
    return () => this.ee.off(`task:${taskId}`, fn);
  }
}
