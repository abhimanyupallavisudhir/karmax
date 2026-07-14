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

export class WebhookDeliveryAdapter implements DeliveryAdapter {
  constructor(private url: string, private channel: 'email' | 'slack', private fetcher: typeof fetch = fetch) {}
  async deliver(envelope: DeliveryEnvelope): Promise<void> {
    const response = await this.fetcher(this.url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: this.channel, ...envelope }) });
    if (!response.ok) throw new Error(`${this.channel} delivery returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
}

/** Durable at-least-once delivery worker. Inbox rows are the truth; adapters are
 * retryable projections and can never create or suppress responsibility. */
export class DeliveryDispatcher {
  private timer?: NodeJS.Timeout;
  private running = false;
  constructor(private store: Store, private adapters: Partial<Record<'browser' | 'email' | 'slack', DeliveryAdapter>>,
    private user?: (id: string) => { id: string; name?: string; email?: string } | undefined, private intervalMs = 1_000) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.drain(), this.intervalMs);
    this.timer.unref();
    void this.drain();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  async drain(limit = 100): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let delivered = 0;
    try {
      for (let i = 0; i < limit; i++) {
        const claim = this.store.claimDelivery();
        if (!claim) break;
        try {
          const adapter = this.adapters[claim.channel];
          if (!adapter) throw new Error(`${claim.channel} delivery is enabled but no adapter is configured`);
          const task = this.store.getTask(claim.inbox.taskId);
          await adapter.deliver({ inbox: claim.inbox,
            task: task ? { id: task.id, num: task.num, title: task.title } : undefined,
            user: this.user?.(claim.inbox.userId) });
          this.store.completeDelivery(claim.id);
          delivered++;
        } catch (error) {
          this.store.failDelivery(claim.id, error instanceof Error ? error.message : String(error), claim.attempts);
        }
      }
      return delivered;
    } finally {
      this.running = false;
    }
  }
}
