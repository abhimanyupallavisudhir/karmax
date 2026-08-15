import crypto from 'node:crypto';
import type { Store } from '../store/db.js';

export type HostedPlan = 'free' | 'individual' | 'team';
export type SubscriptionStatus = 'none' | 'trialing' | 'active' | 'past_due' | 'unpaid'
  | 'incomplete' | 'incomplete_expired' | 'paused' | 'canceled';

export interface SubscriptionCatalogConfig {
  individualPriceId: string;
  teamBasePriceId: string;
  teamSeatPriceId: string;
  individualProductId?: string;
  teamProductId?: string;
}

export interface BillingAccount {
  organizationId: string;
  provider: string;
  customerId?: string;
  subscriptionId?: string;
  plan: HostedPlan;
  status: SubscriptionStatus;
  seats: number;
  items: Record<string, string>;
  currentPeriodEnd?: number;
  cancelAtPeriodEnd: boolean;
  lastEventAt: number;
  verifiedAt?: number;
  lastError?: string;
}

export interface SubscriptionProvider {
  readonly name: string;
  configured(): boolean;
  catalog(): SubscriptionCatalogConfig | undefined;
  createCustomer(input: { organizationId: string; name: string; idempotencyKey: string }): Promise<{ id: string }>;
  createCheckout(input: { organizationId: string; customerId: string; plan: Exclude<HostedPlan, 'free'>;
    seats: number; successUrl: string; cancelUrl: string; idempotencyKey: string }): Promise<{ id: string; url: string }>;
  createPortal(input: { customerId: string; returnUrl: string; idempotencyKey: string }): Promise<{ url: string }>;
  changePlan(input: { subscriptionId: string; plan: Exclude<HostedPlan, 'free'>; seats: number;
    items: Record<string, string>; idempotencyKey: string }): Promise<{ id: string }>;
  cancelAtPeriodEnd(input: { subscriptionId: string; idempotencyKey: string }): Promise<{ id: string }>;
  updateSeats(input: { subscriptionId: string; seatItemId?: string; seats: number;
    idempotencyKey: string }): Promise<{ id: string }>;
  verifyWebhook(raw: Buffer, signature?: string): BillingEvent;
}

export interface BillingEvent {
  id: string;
  type: string;
  created: number;
  data: { object: any };
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Stripe Billing adapter. This is intentionally unrelated to StripeIssuingProvider:
 * it uses a platform-owned Billing key and never exposes or provisions agent cards. */
export class StripeSubscriptionProvider implements SubscriptionProvider {
  readonly name = 'stripe-billing';
  constructor(private env: NodeJS.ProcessEnv = process.env, private fetcher: FetchLike = fetch) {}

  configured(): boolean {
    return Boolean(this.secretKey() && this.webhookSecret() && this.catalog());
  }

  catalog(): SubscriptionCatalogConfig | undefined {
    const individualPriceId = this.env.KARMAX_SUBSCRIPTION_STRIPE_INDIVIDUAL_PRICE_ID?.trim();
    const teamBasePriceId = this.env.KARMAX_SUBSCRIPTION_STRIPE_TEAM_BASE_PRICE_ID?.trim();
    const teamSeatPriceId = this.env.KARMAX_SUBSCRIPTION_STRIPE_TEAM_SEAT_PRICE_ID?.trim();
    if (!individualPriceId || !teamBasePriceId || !teamSeatPriceId) return undefined;
    return { individualPriceId, teamBasePriceId, teamSeatPriceId,
      individualProductId: this.env.KARMAX_SUBSCRIPTION_STRIPE_INDIVIDUAL_PRODUCT_ID?.trim() || undefined,
      teamProductId: this.env.KARMAX_SUBSCRIPTION_STRIPE_TEAM_PRODUCT_ID?.trim() || undefined };
  }

  async createCustomer(input: { organizationId: string; name: string; idempotencyKey: string }) {
    return this.request('/v1/customers', {
      name: input.name, 'metadata[karmax_organization_id]': input.organizationId,
    }, input.idempotencyKey);
  }

  async createCheckout(input: { organizationId: string; customerId: string; plan: Exclude<HostedPlan, 'free'>;
    seats: number; successUrl: string; cancelUrl: string; idempotencyKey: string }) {
    const catalog = this.requireCatalog();
    const params: Record<string, string | number | boolean> = {
      mode: 'subscription', customer: input.customerId, success_url: input.successUrl,
      cancel_url: input.cancelUrl, client_reference_id: input.organizationId,
      'subscription_data[metadata][karmax_organization_id]': input.organizationId,
      'line_items[0][price]': input.plan === 'individual' ? catalog.individualPriceId : catalog.teamBasePriceId,
      'line_items[0][quantity]': 1, allow_promotion_codes: true,
    };
    if (input.plan === 'team' && input.seats > 1) {
      params['line_items[1][price]'] = catalog.teamSeatPriceId;
      params['line_items[1][quantity]'] = input.seats - 1;
    }
    return this.request('/v1/checkout/sessions', params, input.idempotencyKey);
  }

  createPortal(input: { customerId: string; returnUrl: string; idempotencyKey: string }) {
    return this.request('/v1/billing_portal/sessions', { customer: input.customerId,
      return_url: input.returnUrl }, input.idempotencyKey);
  }

  changePlan(input: { subscriptionId: string; plan: Exclude<HostedPlan, 'free'>; seats: number;
    items: Record<string, string>; idempotencyKey: string }) {
    const catalog = this.requireCatalog();
    const params: Record<string, string | number | boolean> = { proration_behavior: 'create_prorations' };
    const baseItem = input.items.individual || input.items.teamBase;
    if (!baseItem) throw new Error('the verified subscription item is unavailable; retry after billing reconciliation');
    params['items[0][id]'] = baseItem;
    params['items[0][price]'] = input.plan === 'individual' ? catalog.individualPriceId : catalog.teamBasePriceId;
    params['items[0][quantity]'] = 1;
    if (input.plan === 'individual' && input.items.teamSeat) {
      params['items[1][id]'] = input.items.teamSeat;
      params['items[1][deleted]'] = true;
    } else if (input.plan === 'team' && input.seats > 1) {
      if (input.items.teamSeat) params['items[1][id]'] = input.items.teamSeat;
      params['items[1][price]'] = catalog.teamSeatPriceId;
      params['items[1][quantity]'] = input.seats - 1;
    }
    return this.request(`/v1/subscriptions/${encodeURIComponent(input.subscriptionId)}`, params, input.idempotencyKey);
  }

  cancelAtPeriodEnd(input: { subscriptionId: string; idempotencyKey: string }) {
    return this.request(`/v1/subscriptions/${encodeURIComponent(input.subscriptionId)}`,
      { cancel_at_period_end: true }, input.idempotencyKey);
  }

  updateSeats(input: { subscriptionId: string; seatItemId?: string; seats: number; idempotencyKey: string }) {
    const catalog = this.requireCatalog();
    const params: Record<string, string | number | boolean> = { proration_behavior: 'create_prorations' };
    if (input.seatItemId) params['items[0][id]'] = input.seatItemId;
    params['items[0][price]'] = catalog.teamSeatPriceId;
    if (input.seats <= 1 && input.seatItemId) params['items[0][deleted]'] = true;
    else params['items[0][quantity]'] = Math.max(1, input.seats - 1);
    return this.request(`/v1/subscriptions/${encodeURIComponent(input.subscriptionId)}`, params, input.idempotencyKey);
  }

  verifyWebhook(raw: Buffer, signature?: string): BillingEvent {
    const secret = this.webhookSecret();
    if (!secret || !signature) throw new Error('subscription webhook signing is not configured');
    const parts = Object.fromEntries(signature.split(',').map((part) => part.split('=', 2) as [string, string]));
    const timestamp = Number(parts.t);
    const candidates = signature.split(',').filter((part) => part.startsWith('v1=')).map((part) => part.slice(3));
    if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300 || !candidates.length)
      throw new Error('invalid or expired subscription webhook signature');
    const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${raw.toString('utf8')}`).digest('hex');
    const valid = candidates.some((candidate) => candidate.length === expected.length
      && crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(expected)));
    if (!valid) throw new Error('invalid subscription webhook signature');
    const event = JSON.parse(raw.toString('utf8')) as BillingEvent;
    if (!event?.id || !event?.type || !event?.data?.object || !Number.isFinite(Number(event.created)))
      throw new Error('invalid subscription webhook event');
    return event;
  }

  private secretKey(): string | undefined { return this.env.KARMAX_SUBSCRIPTION_STRIPE_SECRET_KEY?.trim(); }
  private webhookSecret(): string | undefined { return this.env.KARMAX_SUBSCRIPTION_STRIPE_WEBHOOK_SECRET?.trim(); }
  private requireCatalog(): SubscriptionCatalogConfig {
    const catalog = this.catalog();
    if (!catalog) throw new Error('subscription price identifiers are not configured');
    return catalog;
  }
  private async request(path: string, params: Record<string, string | number | boolean>, idempotencyKey: string): Promise<any> {
    const key = this.secretKey();
    if (!key) throw new Error('Stripe subscription billing is not configured');
    const body = new URLSearchParams();
    for (const [name, value] of Object.entries(params)) body.set(name, String(value));
    const response = await this.fetcher(`https://api.stripe.com${path}`, { method: 'POST', body,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/x-www-form-urlencoded',
        'idempotency-key': idempotencyKey } });
    const payload = await response.json().catch(() => ({})) as any;
    if (!response.ok) throw new Error(payload?.error?.message || `Stripe Billing returned HTTP ${response.status}`);
    return payload;
  }
}

export class SubscriptionBillingService {
  constructor(private store: Store, private provider: SubscriptionProvider, private hosted: boolean) {}

  current(organizationId: string) {
    const members = this.store.listOrganizationMemberships(organizationId).length;
    if (!this.hosted) return { managed: false, providerConfigured: false, plan: 'self_hosted', status: 'unmetered',
      seats: null, activeUsers: members, seatDeficit: 0, access: 'unmetered', cancelAtPeriodEnd: false,
      catalog: publicCatalog() };
    const account = this.account(organizationId);
    const plan = account?.plan ?? 'free';
    const status = account?.status ?? 'none';
    const seats = plan === 'team' ? account?.seats ?? 1 : 1;
    const graceEndsAt = status === 'past_due' && account?.verifiedAt
      ? account.verifiedAt + 7 * 24 * 60 * 60 * 1000 : undefined;
    const access = ['active', 'trialing'].includes(status) ? 'active'
      : status === 'past_due' && graceEndsAt && graceEndsAt > Date.now() ? 'grace'
        : plan === 'free' || status === 'none' || status === 'canceled' ? 'free' : 'restricted';
    return { managed: true, providerConfigured: this.provider.configured(), plan, status, seats,
      activeUsers: members, seatDeficit: plan === 'team' ? Math.max(0, members - seats) : Math.max(0, members - 1),
      access, cancelAtPeriodEnd: account?.cancelAtPeriodEnd ?? false,
      currentPeriodEnd: account?.currentPeriodEnd, verifiedAt: account?.verifiedAt,
      graceEndsAt, lastError: account?.lastError, catalog: publicCatalog() };
  }

  assertMayAddMember(organizationId: string): void {
    if (!this.hosted) return;
    const state = this.current(organizationId);
    if (state.plan === 'team' && !['active', 'grace'].includes(state.access))
      throw new Error('resolve this organization’s subscription status before adding another active user');
    if (state.plan !== 'team' && state.activeUsers >= 1)
      throw new Error('upgrade this organization to Team before adding another active user');
  }

  async checkout(organizationId: string, plan: Exclude<HostedPlan, 'free'>, urls: { success: string; cancel: string }, key: string) {
    this.requireHosted(); this.requireKey(key);
    if (!['individual', 'team'].includes(plan)) throw new Error('choose Individual or Team');
    const current = this.account(organizationId);
    if (current?.subscriptionId && !['none', 'canceled', 'incomplete_expired'].includes(current.status))
      throw new Error('use Change plan for an existing subscription');
    return this.idempotent(organizationId, `checkout:${plan}`, key, async () => {
      const customerId = await this.ensureCustomer(organizationId, `${key}:customer`);
      const seats = Math.max(1, this.store.listOrganizationMemberships(organizationId).length);
      return this.provider.createCheckout({ organizationId, customerId, plan, seats,
        successUrl: urls.success, cancelUrl: urls.cancel, idempotencyKey: `${key}:checkout` });
    });
  }

  async portal(organizationId: string, returnUrl: string, key: string) {
    this.requireHosted(); this.requireKey(key);
    const customerId = this.account(organizationId)?.customerId;
    if (!customerId) throw new Error('no billing account exists for this organization');
    return this.idempotent(organizationId, 'portal', key,
      () => this.provider.createPortal({ customerId, returnUrl, idempotencyKey: `${key}:portal` }));
  }

  async changePlan(organizationId: string, plan: Exclude<HostedPlan, 'free'>, key: string) {
    this.requireHosted(); this.requireKey(key);
    if (!['individual', 'team'].includes(plan)) throw new Error('choose Individual or Team');
    const account = this.account(organizationId);
    if (!account?.subscriptionId || !['active', 'trialing', 'past_due'].includes(account.status))
      throw new Error('there is no changeable subscription');
    const seats = Math.max(1, this.store.listOrganizationMemberships(organizationId).length);
    if (plan === 'individual' && seats > 1) throw new Error('remove additional active users before downgrading to Individual');
    return this.idempotent(organizationId, `change:${plan}`, key, () => this.provider.changePlan({
      subscriptionId: account.subscriptionId!, plan, seats, items: account.items, idempotencyKey: `${key}:change`,
    }));
  }

  async cancel(organizationId: string, key: string) {
    this.requireHosted(); this.requireKey(key);
    const account = this.account(organizationId);
    if (!account?.subscriptionId || !['active', 'trialing', 'past_due'].includes(account.status))
      throw new Error('there is no cancellable subscription');
    return this.idempotent(organizationId, 'cancel', key, () => this.provider.cancelAtPeriodEnd({
      subscriptionId: account.subscriptionId!, idempotencyKey: `${key}:cancel`,
    }));
  }

  async syncSeats(organizationId: string): Promise<void> {
    if (!this.hosted) return;
    const account = this.account(organizationId);
    if (!account?.subscriptionId || account.plan !== 'team' || !['active', 'trialing', 'past_due'].includes(account.status)) return;
    const seats = Math.max(1, this.store.listOrganizationMemberships(organizationId).length);
    if (seats === account.seats) return;
    await this.provider.updateSeats({ subscriptionId: account.subscriptionId,
      seatItemId: account.items.teamSeat, seats,
      idempotencyKey: `seat-sync:${organizationId}:${seats}:${account.lastEventAt}` });
  }

  handleWebhook(raw: Buffer, signature?: string): { duplicate: boolean } {
    this.requireHosted();
    const event = this.provider.verifyWebhook(raw, signature);
    const claim = this.store.db.prepare(`INSERT OR IGNORE INTO subscription_billing_events
      (provider, eventId, type, createdAt, processedAt) VALUES (?, ?, ?, ?, NULL)`)
      .run(this.provider.name, event.id, event.type, event.created * 1000);
    if (Number(claim.changes) === 0) return { duplicate: true };
    try {
      this.applyEvent(event);
      this.store.db.prepare('UPDATE subscription_billing_events SET processedAt=? WHERE provider=? AND eventId=?')
        .run(Date.now(), this.provider.name, event.id);
      return { duplicate: false };
    } catch (error) {
      this.store.db.prepare('DELETE FROM subscription_billing_events WHERE provider=? AND eventId=?')
        .run(this.provider.name, event.id);
      throw error;
    }
  }

  private applyEvent(event: BillingEvent): void {
    const object = event.data.object;
    const customerId = stringId(object.customer);
    const subscriptionId = event.type.startsWith('customer.subscription.') ? String(object.id)
      : stringId(object.subscription);
    const account = customerId ? this.accountByCustomer(customerId) : subscriptionId ? this.accountBySubscription(subscriptionId) : undefined;
    if (!account) return; // Never adopt a tenant association from provider metadata.
    if (event.created * 1000 < account.lastEventAt) return;
    if (event.type === 'checkout.session.completed') {
      // This event associates the provider subscription but carries no verified
      // line-item snapshot. Do not advance the reconciliation clock: Stripe may
      // deliver the slightly older subscription.created event afterwards.
      if (subscriptionId) this.patchAccount(account.organizationId, { subscriptionId });
      return;
    }
    if (event.type.startsWith('customer.subscription.')) {
      if (event.type === 'customer.subscription.deleted') {
        this.patchAccount(account.organizationId, { subscriptionId, status: 'canceled', plan: 'free', seats: 1,
          items: {}, cancelAtPeriodEnd: false, currentPeriodEnd: epochMs(object.current_period_end),
          lastEventAt: event.created * 1000, verifiedAt: Date.now() });
        return;
      }
      const mapped = this.mapSubscription(object);
      this.patchAccount(account.organizationId, { subscriptionId: String(object.id), ...mapped,
        status: normalizeStatus(object.status), cancelAtPeriodEnd: Boolean(object.cancel_at_period_end),
        currentPeriodEnd: epochMs(object.current_period_end), lastEventAt: event.created * 1000,
        verifiedAt: Date.now(), lastError: undefined });
      return;
    }
    if (event.type === 'invoice.payment_failed') {
      this.patchAccount(account.organizationId, { status: 'past_due', lastError: 'The latest subscription payment failed.',
        lastEventAt: event.created * 1000, verifiedAt: Date.now() });
    } else if (event.type === 'invoice.paid' && account.plan !== 'free') {
      this.patchAccount(account.organizationId, { status: 'active', lastError: undefined,
        lastEventAt: event.created * 1000, verifiedAt: Date.now() });
    }
  }

  private mapSubscription(object: any): { plan: HostedPlan; seats: number; items: Record<string, string> } {
    const catalog = this.provider.catalog();
    if (!catalog) throw new Error('subscription catalog is not configured');
    const items: Record<string, string> = {};
    let plan: HostedPlan | undefined;
    let seats = 1;
    for (const item of object.items?.data ?? []) {
      const price = stringId(item.price);
      const product = stringId(item.price?.product);
      if (price === catalog.individualPriceId) {
        if (plan) throw new Error('subscription contains multiple configured base plan prices');
        if (catalog.individualProductId && product !== catalog.individualProductId)
          throw new Error('Individual price belongs to an unexpected Stripe product');
        plan = 'individual'; items.individual = String(item.id);
      } else if (price === catalog.teamBasePriceId) {
        if (plan) throw new Error('subscription contains multiple configured base plan prices');
        if (catalog.teamProductId && product !== catalog.teamProductId)
          throw new Error('Team base price belongs to an unexpected Stripe product');
        plan = 'team'; items.teamBase = String(item.id);
      } else if (price === catalog.teamSeatPriceId) {
        if (catalog.teamProductId && product !== catalog.teamProductId)
          throw new Error('Team seat price belongs to an unexpected Stripe product');
        const quantity = Number(item.quantity);
        if (!Number.isSafeInteger(quantity) || quantity < 0) throw new Error('Team seat quantity is invalid');
        seats += quantity; items.teamSeat = String(item.id);
      }
    }
    if (!plan) throw new Error('subscription contains no configured Karmax plan price');
    return { plan, seats: plan === 'team' ? seats : 1, items };
  }

  private account(organizationId: string): BillingAccount | undefined {
    return rowAccount(this.store.db.prepare('SELECT * FROM subscription_billing_accounts WHERE organizationId=?').get(organizationId) as any);
  }
  private accountByCustomer(customerId: string): BillingAccount | undefined {
    return rowAccount(this.store.db.prepare('SELECT * FROM subscription_billing_accounts WHERE customerId=?').get(customerId) as any);
  }
  private accountBySubscription(subscriptionId: string): BillingAccount | undefined {
    return rowAccount(this.store.db.prepare('SELECT * FROM subscription_billing_accounts WHERE subscriptionId=?').get(subscriptionId) as any);
  }
  private async ensureCustomer(organizationId: string, key: string): Promise<string> {
    const existing = this.account(organizationId)?.customerId;
    if (existing) return existing;
    const organization = this.store.getOrganization(organizationId);
    if (!organization) throw new Error('organization not found');
    const customer = await this.provider.createCustomer({ organizationId, name: organization.name, idempotencyKey: key });
    const now = Date.now();
    this.store.db.prepare(`INSERT INTO subscription_billing_accounts
      (organizationId, provider, customerId, plan, status, seats, itemsJson, cancelAtPeriodEnd, lastEventAt, createdAt, updatedAt)
      VALUES (?, ?, ?, 'free', 'none', 1, '{}', 0, 0, ?, ?)
      ON CONFLICT(organizationId) DO UPDATE SET customerId=excluded.customerId, updatedAt=excluded.updatedAt`)
      .run(organizationId, this.provider.name, customer.id, now, now);
    return customer.id;
  }
  private patchAccount(organizationId: string, patch: Partial<BillingAccount>): void {
    const current = this.account(organizationId);
    if (!current) throw new Error('billing account not found');
    this.store.db.prepare(`UPDATE subscription_billing_accounts SET subscriptionId=?, plan=?, status=?, seats=?,
      itemsJson=?, currentPeriodEnd=?, cancelAtPeriodEnd=?, lastEventAt=?, verifiedAt=?, lastError=?, updatedAt=?
      WHERE organizationId=?`).run(patch.subscriptionId ?? current.subscriptionId ?? null,
      patch.plan ?? current.plan, patch.status ?? current.status, patch.seats ?? current.seats,
      JSON.stringify(patch.items ?? current.items), patch.currentPeriodEnd ?? current.currentPeriodEnd ?? null,
      (patch.cancelAtPeriodEnd ?? current.cancelAtPeriodEnd) ? 1 : 0, patch.lastEventAt ?? current.lastEventAt,
      patch.verifiedAt ?? current.verifiedAt ?? null,
      Object.prototype.hasOwnProperty.call(patch, 'lastError') ? patch.lastError ?? null : current.lastError ?? null,
      Date.now(), organizationId);
  }
  private async idempotent<T>(organizationId: string, operation: string, key: string, work: () => Promise<T>): Promise<T> {
    const hash = crypto.createHash('sha256').update(`${organizationId}:${operation}`).digest('hex');
    const prior = this.store.db.prepare('SELECT * FROM subscription_billing_requests WHERE requestKey=?').get(key) as any;
    if (prior) {
      if (prior.organizationId !== organizationId || prior.requestHash !== hash) throw new Error('idempotency key was already used for another billing request');
      if (prior.responseJson) return JSON.parse(prior.responseJson) as T;
      // A process can die after reserving the local key but before saving the
      // response. Stripe retains the same provider idempotency key, so releasing
      // only a stale local reservation resumes safely without duplicating money.
      if (Number(prior.createdAt) > Date.now() - 5 * 60_000)
        throw new Error('an identical billing request is already in progress');
      this.store.db.prepare('DELETE FROM subscription_billing_requests WHERE requestKey=? AND responseJson IS NULL').run(key);
    }
    this.store.db.prepare(`INSERT INTO subscription_billing_requests
      (requestKey, organizationId, operation, requestHash, responseJson, createdAt) VALUES (?, ?, ?, ?, NULL, ?)`)
      .run(key, organizationId, operation, hash, Date.now());
    try {
      const response = await work();
      this.store.db.prepare('UPDATE subscription_billing_requests SET responseJson=? WHERE requestKey=?')
        .run(JSON.stringify(response), key);
      return response;
    } catch (error) {
      this.store.db.prepare('DELETE FROM subscription_billing_requests WHERE requestKey=? AND responseJson IS NULL').run(key);
      throw error;
    }
  }
  private requireHosted(): void {
    if (!this.hosted) throw new Error('hosted subscription billing is not used by self-hosted installations');
    if (!this.provider.configured()) throw new Error('hosted subscription billing is not configured');
  }
  private requireKey(key: string): void {
    if (!/^[A-Za-z0-9._:-]{8,200}$/.test(key)) throw new Error('a valid Idempotency-Key header is required');
  }
}

/** Hermetic provider for unit/integration tests; no network and no Stripe SDK. */
export class FakeSubscriptionProvider implements SubscriptionProvider {
  readonly name = 'fake-billing';
  readonly calls: Array<{ method: string; input: any }> = [];
  constructor(private config: SubscriptionCatalogConfig = {
    individualPriceId: 'price_individual', teamBasePriceId: 'price_team_base', teamSeatPriceId: 'price_team_seat',
  }) {}
  configured() { return true; }
  catalog() { return this.config; }
  async createCustomer(input: any) { this.calls.push({ method: 'createCustomer', input }); return { id: `cus_${input.organizationId}` }; }
  async createCheckout(input: any) { this.calls.push({ method: 'createCheckout', input }); return { id: 'cs_test', url: 'https://checkout.test/session' }; }
  async createPortal(input: any) { this.calls.push({ method: 'createPortal', input }); return { url: 'https://portal.test/session' }; }
  async changePlan(input: any) { this.calls.push({ method: 'changePlan', input }); return { id: input.subscriptionId }; }
  async cancelAtPeriodEnd(input: any) { this.calls.push({ method: 'cancelAtPeriodEnd', input }); return { id: input.subscriptionId }; }
  async updateSeats(input: any) { this.calls.push({ method: 'updateSeats', input }); return { id: input.subscriptionId }; }
  verifyWebhook(raw: Buffer): BillingEvent { return JSON.parse(raw.toString('utf8')); }
}

function rowAccount(row: any): BillingAccount | undefined {
  if (!row) return undefined;
  return { organizationId: row.organizationId, provider: row.provider, customerId: row.customerId ?? undefined,
    subscriptionId: row.subscriptionId ?? undefined, plan: row.plan, status: row.status, seats: Number(row.seats),
    items: JSON.parse(row.itemsJson || '{}'), currentPeriodEnd: row.currentPeriodEnd ?? undefined,
    cancelAtPeriodEnd: Boolean(row.cancelAtPeriodEnd), lastEventAt: Number(row.lastEventAt),
    verifiedAt: row.verifiedAt ?? undefined, lastError: row.lastError ?? undefined };
}
function stringId(value: any): string | undefined { return typeof value === 'string' ? value : value?.id ? String(value.id) : undefined; }
function epochMs(value: any): number | undefined { const n = Number(value); return Number.isFinite(n) && n > 0 ? n * 1000 : undefined; }
function normalizeStatus(value: any): SubscriptionStatus {
  const status = String(value || 'incomplete') as SubscriptionStatus;
  return ['none', 'trialing', 'active', 'past_due', 'unpaid', 'incomplete', 'incomplete_expired', 'paused', 'canceled'].includes(status)
    ? status : 'incomplete';
}
function publicCatalog() {
  return [
    { id: 'free', name: 'Free', monthlyBaseCents: 0, includedUsers: 1, additionalUserCents: 0, selfService: true },
    { id: 'individual', name: 'Individual', monthlyBaseCents: 900, includedUsers: 1, additionalUserCents: 0, selfService: true },
    { id: 'team', name: 'Team', monthlyBaseCents: 1900, includedUsers: 1, additionalUserCents: 500, selfService: true },
    { id: 'enterprise', name: 'Enterprise', selfService: false },
  ];
}
