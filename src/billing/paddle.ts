import crypto from 'node:crypto';
import { HOSTED_PLANS } from '../domain/entitlements.js';
import type { BillingEvent, BillingRequestIntent, SubscriptionCatalogConfig, SubscriptionProvider } from './subscriptions.js';

export const PADDLE_WEBHOOK_EVENTS = ['subscription.created', 'subscription.updated', 'subscription.activated',
  'subscription.trialing', 'subscription.past_due', 'subscription.paused', 'subscription.resumed', 'subscription.canceled'] as const;

export interface PaddleRuntimeConfig extends Partial<SubscriptionCatalogConfig> {
  environment?: 'sandbox' | 'live';
  apiKey?: string;
  webhookSecret?: string;
  clientToken?: string;
}

/** A definite provider rejection is safe to retry after correcting the request.
 * Network errors and 5xx responses are deliberately NOT classified this way. */
export class BillingRequestRejected extends Error {}

/** Paddle Billing, not Paddle Classic. Checkout collects the payer's real email.
 * Tenant association comes exclusively from our stored transaction ID. */
export class PaddleSubscriptionProvider implements SubscriptionProvider {
  readonly name = 'paddle-billing';
  readonly customerMode = 'checkout' as const;
  readonly supportsIdempotency = false;
  constructor(private source: () => PaddleRuntimeConfig | Promise<PaddleRuntimeConfig>,
    private fetcher: typeof fetch = fetch) {}

  async configured() {
    const c = await this.source();
    return Boolean(c.apiKey && c.webhookSecret && c.clientToken && await this.catalog());
  }
  async catalog(): Promise<SubscriptionCatalogConfig | undefined> {
    const c = await this.source();
    if (!c.individualPriceId || !c.teamBasePriceId || !c.teamSeatPriceId) return undefined;
    return { individualPriceId: c.individualPriceId, teamBasePriceId: c.teamBasePriceId,
      teamSeatPriceId: c.teamSeatPriceId, individualProductId: c.individualProductId, teamProductId: c.teamProductId };
  }
  async createCustomer(): Promise<{ id: string }> {
    throw new Error('Paddle collects customer details during checkout');
  }
  async createCheckout(input: Parameters<SubscriptionProvider['createCheckout']>[0]) {
    const items = await this.items(input.plan, input.seats);
    const checkout = checkoutUrl(input.successUrl);
    const transaction = await this.request('/transactions', 'POST', { items, collection_mode: 'automatic',
      custom_data: { karmax_request: input.idempotencyKey },
      checkout: { url: checkout.toString() } });
    if (!transaction?.id || !/^txn_[a-zA-Z0-9]+$/.test(transaction.id))
      throw new Error('Paddle returned an invalid transaction; reconcile before retrying');
    checkout.searchParams.set('_ptxn', transaction.id);
    return { id: transaction.id, url: checkout.toString() };
  }
  async resumeCheckout(input: Parameters<NonNullable<SubscriptionProvider['resumeCheckout']>>[0]) {
    const path = `/transactions/${encodeURIComponent(input.checkoutId)}`;
    const transaction = await this.request(path, 'GET');
    if (transaction.status === 'canceled') return null;
    if (!['draft', 'ready'].includes(transaction.status))
      throw new BillingRequestRejected('Paddle is processing the existing checkout; wait for payment confirmation');
    const items = await this.items(input.plan, input.seats);
    // Do not change a previously accepted checkout's commercial terms in place.
    // Invalidate its old link before creating a replacement at the new price.
    if (!sameItems(transaction.items, items)) {
      await this.cancelCheckout(input.checkoutId);
      return null;
    }
    const url = checkoutUrl(input.successUrl);
    url.searchParams.set('_ptxn', input.checkoutId);
    return { id: input.checkoutId, url: url.toString() };
  }
  async cancelCheckout(checkoutId: string) {
    const path = `/transactions/${encodeURIComponent(checkoutId)}`;
    const transaction = await this.request(path, 'GET');
    if (transaction.status === 'canceled') return { id: checkoutId };
    if (!['draft', 'ready'].includes(transaction.status))
      throw new BillingRequestRejected('payment is already processing; wait for subscription confirmation before canceling');
    const result = await this.request(path, 'PATCH', { status: 'canceled' });
    if (result.status !== 'canceled') throw new Error('Paddle checkout cancellation needs reconciliation');
    return { id: checkoutId };
  }
  async createPortal(input: Parameters<SubscriptionProvider['createPortal']>[0]) {
    if (!input.subscriptionId) throw new BillingRequestRejected('no Paddle subscription exists');
    const subscription = await this.request(`/subscriptions/${encodeURIComponent(input.subscriptionId)}`, 'GET');
    // These links require Paddle's email authentication. Do not mint a customer-
    // wide session: a single payer can fund several independently owned tenants.
    const url = subscription.management_urls?.update_payment_method;
    if (typeof url !== 'string' || !/^https:\/\/(?:sandbox-)?customer-portal\.paddle\.com\//.test(url))
      throw new BillingRequestRejected('Paddle has not provided a billing portal link');
    return { url };
  }
  async changePlan(input: Parameters<SubscriptionProvider['changePlan']>[0]) {
    const items = await this.items(input.plan, input.seats);
    const current = await this.request(`/subscriptions/${encodeURIComponent(input.subscriptionId)}`, 'GET');
    if (sameItems(current.items, items)) return { id: input.subscriptionId };
    return this.request(`/subscriptions/${encodeURIComponent(input.subscriptionId)}`, 'PATCH', {
      items, proration_billing_mode: 'prorated_next_billing_period',
    });
  }
  async cancelAtPeriodEnd(input: Parameters<SubscriptionProvider['cancelAtPeriodEnd']>[0]) {
    const current = await this.request(`/subscriptions/${encodeURIComponent(input.subscriptionId)}`, 'GET');
    if (current.scheduled_change?.action === 'cancel' || current.status === 'canceled') return { id: input.subscriptionId };
    return this.request(`/subscriptions/${encodeURIComponent(input.subscriptionId)}/cancel`, 'POST', { effective_from: 'next_billing_period' });
  }
  async updateSeats(input: Parameters<SubscriptionProvider['updateSeats']>[0]) {
    const subscription = await this.request(`/subscriptions/${encodeURIComponent(input.subscriptionId)}`, 'GET');
    const catalog = await this.catalog();
    if (!catalog || !subscription.items?.some((item: any) => item.price?.id === catalog.teamBasePriceId))
      throw new BillingRequestRejected('cannot update seats on a non-Team Paddle subscription');
    if (subscription.items.some((item: any) => ![catalog.teamBasePriceId, catalog.teamSeatPriceId].includes(item.price?.id)))
      throw new BillingRequestRejected('Paddle subscription has unexpected items; reconcile before changing seats');
    const items = await this.items('team', input.seats);
    if (sameItems(subscription.items, items)) return { id: input.subscriptionId };
    return this.request(`/subscriptions/${encodeURIComponent(input.subscriptionId)}`, 'PATCH', {
      items, proration_billing_mode: 'prorated_next_billing_period',
    });
  }
  async verifyWebhook(raw: Buffer, signature?: string): Promise<BillingEvent> {
    const c = await this.source();
    const parts = signature?.split(';').map((part) => part.trim()) ?? [];
    const timestamps = parts.filter((part) => part.startsWith('ts=')).map((part) => part.slice(3));
    const timestamp = timestamps[0];
    if (!c.webhookSecret || timestamps.length !== 1 || !timestamp || !/^\d+$/.test(timestamp)
      || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300)
      throw new Error('invalid or expired Paddle webhook signature');
    const expected = crypto.createHmac('sha256', c.webhookSecret).update(`${timestamp}:`).update(raw).digest();
    if (!parts.filter((part) => part.startsWith('h1=')).some((part) => {
      const hash = part.slice(3);
      return /^[a-f0-9]{64}$/i.test(hash) && crypto.timingSafeEqual(Buffer.from(hash, 'hex'), expected);
    })) throw new Error('invalid Paddle webhook signature');
    const event = JSON.parse(raw.toString('utf8'));
    const created = Date.parse(event.occurred_at) / 1000;
    if (typeof event.event_id !== 'string' || !event.event_id || !Number.isFinite(created)
      || typeof event.event_type !== 'string' || !event.data || typeof event.data !== 'object')
      throw new Error('invalid Paddle webhook event');
    if (!(PADDLE_WEBHOOK_EVENTS as readonly string[]).includes(event.event_type))
      return { id: event.event_id, type: 'ignored', created, data: { object: {} } };
    const s = event.data;
    if (typeof s.id !== 'string' || !s.id.startsWith('sub_') || typeof s.customer_id !== 'string'
      || !['active', 'trialing', 'past_due', 'paused', 'canceled'].includes(s.status) || !Array.isArray(s.items))
      throw new Error('invalid Paddle subscription snapshot');
    const end = s.current_billing_period?.ends_at ? Date.parse(s.current_billing_period.ends_at) / 1000 : undefined;
    // BillingEvent is the existing internal reconciliation format, not a raw
    // Stripe event. Retain it so both providers share the tested state machine.
    return { id: event.event_id, created,
      type: s.status === 'canceled' ? 'customer.subscription.deleted' : 'customer.subscription.updated',
      checkoutId: event.event_type === 'subscription.created' ? s.transaction_id : undefined,
      data: { object: { id: s.id, customer: s.customer_id, status: s.status,
        cancel_at_period_end: s.scheduled_change?.action === 'cancel', current_period_end: end,
        items: { data: s.items.map((item: any) => ({ id: item.price?.id,
          price: { id: item.price?.id, product: item.price?.product_id }, quantity: item.quantity })) } } } };
  }
  /** Absence is claimed only from a successful, complete read showing that the
   * write had no effect; anything ambiguous stays null for an operator. */
  async reconcileRequest(intent: BillingRequestIntent, reference: string, createdAt: number) {
    const absent = { absent: true } as const;
    if (intent.kind === 'abandon') {
      if (!intent.checkoutId) return null;
      const transaction = await this.request(`/transactions/${encodeURIComponent(intent.checkoutId)}`, 'GET');
      return transaction.status === 'canceled' ? { id: intent.checkoutId } : absent;
    }
    if (intent.kind !== 'checkout') {
      if (!intent.subscriptionId) return null;
      const subscription = await this.request(`/subscriptions/${encodeURIComponent(intent.subscriptionId)}`, 'GET');
      if (intent.kind === 'cancel') return subscription.status === 'canceled' || subscription.scheduled_change?.action === 'cancel'
        ? { id: intent.subscriptionId } : absent;
      if (!intent.plan || !intent.seats) return null;
      return sameItems(subscription.items, await this.items(intent.plan, intent.seats)) ? { id: intent.subscriptionId } : absent;
    }
    if (!intent.plan || !intent.seats || !intent.successUrl) return null;
    let found: any;
    if (intent.checkoutId) {
      found = await this.request(`/transactions/${encodeURIComponent(intent.checkoutId)}`, 'GET');
      if (found.status === 'canceled') found = undefined;
    }
    if (!found) {
      // The random server-generated reference is persisted BEFORE sending the
      // create call. Require API origin as well; never trust browser custom_data
      // or caller-chosen idempotency keys as a tenant association.
      let next: string | null = `/transactions?per_page=200&origin=api&created_at[GTE]=${encodeURIComponent(new Date(createdAt - 60_000).toISOString())}`;
      const matches: any[] = [];
      let foreign = false;
      for (let page = 0; next && page < 20; page++) {
        const result = await this.request(next, 'GET', undefined, true);
        if (!Array.isArray(result.data)) throw new Error('Paddle transaction reconciliation returned invalid data');
        const carrying = result.data.filter((t: any) => t.custom_data?.karmax_request === `${reference}:checkout`);
        matches.push(...carrying.filter((t: any) => t.origin === 'api'));
        foreign ||= carrying.some((t: any) => t.origin !== 'api');
        next = result.meta?.pagination?.has_more ? result.meta.pagination.next : null;
        if (next) {
          const config = await this.source();
          const base = config.environment === 'sandbox' ? 'https://sandbox-api.paddle.com' : 'https://api.paddle.com';
          const url = new URL(next, base);
          if (url.origin !== base) throw new Error('invalid Paddle reconciliation pagination URL');
          next = url.pathname + url.search;
        }
      }
      if (next || matches.length > 1) return null;
      // A non-API transaction carrying the server reference is an anomaly for
      // an operator, never evidence either way.
      if (!matches.length) return foreign ? null : absent;
      found = matches[0];
    }
    if (found.collection_mode !== 'automatic' || !/^txn_[a-z0-9]+$/.test(found.id)
      || found.status === 'canceled' || !sameItems(found.items, await this.items(intent.plan, intent.seats))) return null;
    const url = checkoutUrl(intent.successUrl);
    url.searchParams.set('_ptxn', found.id);
    return { id: found.id, url: url.toString() };
  }
  private async items(plan: 'individual' | 'team', seats: number) {
    const catalog = await this.catalog();
    if (!catalog) throw new BillingRequestRejected('Paddle prices are not configured');
    if (!Number.isSafeInteger(seats) || seats < 1) throw new BillingRequestRejected('invalid seat count');
    const items = [{ price_id: plan === 'individual' ? catalog.individualPriceId : catalog.teamBasePriceId, quantity: 1 }];
    const extra = seats - HOSTED_PLANS.team.includedActiveUsers;
    if (plan === 'team' && extra > 0) items.push({ price_id: catalog.teamSeatPriceId, quantity: extra });
    return items;
  }
  private async request(path: string, method: string, body?: unknown, envelope = false): Promise<any> {
    const c = await this.source();
    if (!c.apiKey) throw new BillingRequestRejected('Paddle API key is not configured');
    const base = c.environment === 'sandbox' ? 'https://sandbox-api.paddle.com' : 'https://api.paddle.com';
    try {
    const response = await this.fetcher(`${base}${path}`, { method,
      headers: { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json', 'Paddle-Version': '1' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
    const result = await response.json().catch(() => ({})) as any;
    if (!response.ok) {
      const message = `Paddle request failed (${response.status}, ${result.error?.code ?? 'unknown_error'})`;
      if (response.status >= 400 && response.status < 500) throw new BillingRequestRejected(message);
      throw new Error(`${message}; reconcile before retrying`);
    }
    if (!result.data) throw new Error('Paddle returned no data; reconcile before retrying');
    return envelope ? result : result.data;
    } catch (error) {
      // A failed preflight read cannot have performed a financial write.
      if (method === 'GET') throw new BillingRequestRejected(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
}

function sameItems(actual: any, expected: Array<{ price_id: string; quantity: number }>): boolean {
  return Array.isArray(actual) && actual.length === expected.length && expected.every((item) =>
    actual.filter((candidate) => candidate.price?.id === item.price_id && candidate.quantity === item.quantity).length === 1);
}

function checkoutUrl(successUrl: string): URL {
  const url = new URL('/billing/checkout', successUrl);
  url.searchParams.set('success', successUrl);
  return url;
}
