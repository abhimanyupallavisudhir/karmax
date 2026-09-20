import type { Store } from '../store/db.js';
import type { InboxItem } from '../domain/types.js';

export interface DeliveryEnvelope {
  inbox: InboxItem;
  task?: { id: string; num?: number; title: string };
  user?: { id: string; name?: string; email?: string };
}

export interface DeliveryAdapter {
  deliver(envelope: DeliveryEnvelope): Promise<void>;
}

/** Browser delivery is the durable inbox itself; the UI's event/poll cursor is
 * merely transport. Completing this adapter acknowledges materialization. */
export class BrowserDeliveryAdapter implements DeliveryAdapter {
  async deliver(): Promise<void> {}
}

/** How long a single webhook POST may take before it is treated as failed. */
export const WEBHOOK_DELIVERY_TIMEOUT_MS = 20_000;

export class WebhookDeliveryAdapter implements DeliveryAdapter {
  constructor(private url: string, private channel: 'email' | 'slack', private fetcher: typeof fetch = fetch,
    private timeoutMs = WEBHOOK_DELIVERY_TIMEOUT_MS) {}
  async deliver(envelope: DeliveryEnvelope): Promise<void> {
    // Node's fetch has NO default timeout, and `drain()` awaits this call while
    // holding `running = true` — so a black-holed delivery URL (a host that accepts
    // the connection and never answers) parked the ONE dispatcher forever. Every
    // later tick returned early on `if (this.running)`, and because all channels
    // share that loop, browser inbox delivery stopped too. The store's 60s claim
    // reclaim could not help: the only dispatcher was the stuck one.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(this.url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: this.channel, ...envelope }), signal: abort.signal });
      if (!response.ok) throw new Error(`${this.channel} delivery returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
    } catch (error) {
      if (abort.signal.aborted) throw new Error(`${this.channel} delivery timed out after ${this.timeoutMs}ms`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Durable at-least-once delivery worker. Inbox rows are the truth; adapters are
 * retryable projections and can never create or suppress responsibility. */
export class DeliveryDispatcher {
  private timer?: NodeJS.Timeout;
  private running = false;
  constructor(private store: Store, private adapters: Partial<Record<'browser' | 'email' | 'slack', DeliveryAdapter>>,
    private user?: (id: string) => { id: string; name?: string; email?: string } | undefined | Promise<{ id: string; name?: string; email?: string } | undefined>, private intervalMs = 1_000) {}

  start(): void {
    if (this.timer) return;
    // `drain()` CAN reject: `claimDelivery()` runs outside the per-item try (it is
    // the transaction that hands out the claim) and rethrows after its ROLLBACK.
    // A bare `void` there made a locked/corrupt database an unhandled rejection —
    // which, with the process-level backstop gone or in a strict Node, takes the
    // whole app down for a retryable projection failure. Every loop owns its own
    // errors; the interval keeps running and the next tick retries.
    this.timer = setInterval(() => this.drain().catch((e) => this.onDrainError(e)), this.intervalMs);
    this.timer.unref();
    this.drain().catch((e) => this.onDrainError(e));
  }

  private onDrainError(error: unknown): void {
    console.error('[delivery] drain failed:', error instanceof Error ? error.message : String(error));
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  async drain(limit = 100): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let delivered = 0;
    try {
      for (let i = 0; i < limit; i++) {
        const claim = (await this.store.claimDelivery());
        if (!claim) break;
        try {
          const adapter = this.adapters[claim.channel];
          if (!adapter) throw new Error(`${claim.channel} delivery is enabled but no adapter is configured`);
          const task = (await this.store.getTask(claim.inbox.taskId));
          await adapter.deliver({ inbox: claim.inbox,
            task: task ? { id: task.id, num: task.num, title: task.title } : undefined,
            user: (await this.user?.(claim.inbox.userId)) });
          (await this.store.completeDelivery(claim.id));
          delivered++;
        } catch (error) {
          (await this.store.failDelivery(claim.id, error instanceof Error ? error.message : String(error), claim.attempts));
        }
      }
      return delivered;
    } finally {
      this.running = false;
    }
  }
}
