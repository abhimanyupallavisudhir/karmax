import crypto from 'node:crypto';
import { rememberSubscriptionCatalog } from './catalog.js';
import type { Store } from '../store/db.js';
import { HOSTED_PLANS, hostedMonthlyPriceCents, isHostedPlanId,
  type HostedPlanId } from '../domain/entitlements.js';
import type { SubscriptionRuntimeConfig } from '../launch/settings.js';
import { STRIPE_BILLING_API_VERSION } from './stripe-contract.js';
import { BillingRequestRejected } from './paddle.js';

export type PaidHostedPlanId = Exclude<HostedPlanId, 'free'>;
const isPaidHostedPlanId = (value: unknown): value is PaidHostedPlanId =>
  isHostedPlanId(value) && value !== HOSTED_PLANS.free.id;
export const PAST_DUE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
export type SubscriptionStatus = 'none' | 'trialing' | 'active' | 'past_due' | 'unpaid'
  | 'incomplete' | 'incomplete_expired' | 'paused' | 'canceled';
export const TERMINAL_PROVIDER_SUBSCRIPTION_STATUSES = ['canceled', 'incomplete_expired'] as const;

export interface SubscriptionCatalogConfig {
  individualPriceId: string;
  teamBasePriceId: string;
  teamSeatPriceId: string;
  individualProductId?: string;
  teamProductId?: string;
}

/** Authoritative commercial snapshot returned by the canonical checkout service.
 * Policy acceptance is intentionally outside this billing-owned structure. */
export interface SubscriptionCommercialTerms {
  planId: PaidHostedPlanId;
  planName: string;
  currency: 'usd';
  billingInterval: 'month';
  monthlyBasePriceCents: number;
  includedActiveUsers: number;
  monthlyAdditionalActiveUserPriceCents: number;
  activeUsers: number;
  monthlyTotalPriceCents: number;
}

export interface SubscriptionCheckoutResult {
  organizationId: string;
  plan: PaidHostedPlanId;
  commercialTerms: SubscriptionCommercialTerms;
  checkoutRequestReference: string;
  checkoutSessionReference: string;
  checkoutProvider: string;
  url: string;
}

export interface SubscriptionGift {
  plan: PaidHostedPlanId;
  grantedBy: string;
  grantedAt: number;
}

export interface BillingAccount {
  organizationId: string;
  provider: string;
  customerId?: string;
  subscriptionId?: string;
  plan: HostedPlanId;
  status: SubscriptionStatus;
  seats: number;
  items: Record<string, string>;
  currentPeriodEnd?: number;
  cancelAtPeriodEnd: boolean;
  lastEventAt: number;
  lastEventRank: number;
  verifiedAt?: number;
  pastDueAt?: number;
  lastError?: string;
}

export interface SubscriptionProvider {
  readonly name: string;
  readonly customerMode?: 'checkout';
  readonly supportsIdempotency?: boolean;
  configured(): boolean | Promise<boolean>;
  catalog(): SubscriptionCatalogConfig | undefined | Promise<SubscriptionCatalogConfig | undefined>;
  createCustomer(input: { organizationId: string; name: string; idempotencyKey: string }): Promise<{ id: string }>;
  createCheckout(input: { organizationId: string; customerId: string; plan: PaidHostedPlanId;
    seats: number; successUrl: string; cancelUrl: string; idempotencyKey: string }): Promise<{ id: string; url: string }>;
  resumeCheckout?(input: Parameters<SubscriptionProvider['createCheckout']>[0] & { checkoutId: string }): Promise<{ id: string; url: string } | null>;
  cancelCheckout?(checkoutId: string): Promise<{ id: string }>;
  reconcileRequest?(intent: BillingRequestIntent, reference: string, createdAt: number): Promise<{ id: string; url?: string } | null>;
  createPortal(input: { customerId: string; subscriptionId?: string; returnUrl: string; idempotencyKey: string }): Promise<{ url: string }>;
  changePlan(input: { subscriptionId: string; plan: PaidHostedPlanId; seats: number;
    items: Record<string, string>; idempotencyKey: string }): Promise<{ id: string }>;
  cancelAtPeriodEnd(input: { subscriptionId: string; idempotencyKey: string }): Promise<{ id: string }>;
  updateSeats(input: { subscriptionId: string; seatItemId?: string; seats: number;
    idempotencyKey: string }): Promise<{ id: string }>;
  verifyWebhook(raw: Buffer, signature?: string): BillingEvent | Promise<BillingEvent>;
}

export interface BillingEvent {
  id: string;
  type: string;
  created: number;
  checkoutId?: string;
  data: { object: any };
}

export interface BillingRequestIntent {
  kind: 'checkout' | 'change' | 'cancel' | 'seats' | 'abandon';
  subscriptionId?: string;
  checkoutId?: string;
  plan?: PaidHostedPlanId;
  seats?: number;
  successUrl?: string;
  checkoutResult?: Omit<SubscriptionCheckoutResult, 'checkoutSessionReference' | 'url'>;
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Stripe Billing adapter. This is intentionally unrelated to StripeIssuingProvider:
 * it uses a platform-owned Billing key and never exposes or provisions agent cards. */
export class StripeSubscriptionProvider implements SubscriptionProvider {
  readonly name = 'stripe-billing';
  constructor(private source: NodeJS.ProcessEnv | (() => SubscriptionRuntimeConfig | Promise<SubscriptionRuntimeConfig>) = process.env,
    private fetcher: FetchLike = fetch) {}

  private async config(): Promise<SubscriptionRuntimeConfig> {
    if (typeof this.source === 'function') return (await this.source());
    return {
      secretKey: this.source.KARMAX_SUBSCRIPTION_STRIPE_SECRET_KEY?.trim(),
      webhookSecret: this.source.KARMAX_SUBSCRIPTION_STRIPE_WEBHOOK_SECRET?.trim(),
      individualPriceId: this.source.KARMAX_SUBSCRIPTION_STRIPE_INDIVIDUAL_PRICE_ID?.trim(),
      teamBasePriceId: this.source.KARMAX_SUBSCRIPTION_STRIPE_TEAM_BASE_PRICE_ID?.trim(),
      teamSeatPriceId: this.source.KARMAX_SUBSCRIPTION_STRIPE_TEAM_SEAT_PRICE_ID?.trim(),
      individualProductId: this.source.KARMAX_SUBSCRIPTION_STRIPE_INDIVIDUAL_PRODUCT_ID?.trim(),
      teamProductId: this.source.KARMAX_SUBSCRIPTION_STRIPE_TEAM_PRODUCT_ID?.trim(),
    };
  }

  async configured(): Promise<boolean> {
    return Boolean((await this.secretKey()) && (await this.webhookSecret()) && (await this.catalog()));
  }

  async catalog(): Promise<SubscriptionCatalogConfig | undefined> {
    const config = (await this.config());
    const individualPriceId = config.individualPriceId?.trim();
    const teamBasePriceId = config.teamBasePriceId?.trim();
    const teamSeatPriceId = config.teamSeatPriceId?.trim();
    if (!individualPriceId || !teamBasePriceId || !teamSeatPriceId) return undefined;
    return { individualPriceId, teamBasePriceId, teamSeatPriceId,
      individualProductId: config.individualProductId?.trim() || undefined,
      teamProductId: config.teamProductId?.trim() || undefined };
  }

  async createCustomer(input: { organizationId: string; name: string; idempotencyKey: string }) {
    return this.request('/v1/customers', {
      name: input.name, 'metadata[karmax_organization_id]': input.organizationId,
    }, input.idempotencyKey);
  }

  async createCheckout(input: { organizationId: string; customerId: string; plan: PaidHostedPlanId;
    seats: number; successUrl: string; cancelUrl: string; idempotencyKey: string }) {
    const catalog = (await this.requireCatalog());
    const additionalTeamUsers = Math.max(0, input.seats - HOSTED_PLANS.team.includedActiveUsers);
    const params: Record<string, string | number | boolean> = {
      mode: 'subscription', customer: input.customerId, success_url: input.successUrl,
      cancel_url: input.cancelUrl, client_reference_id: input.organizationId,
      'subscription_data[metadata][karmax_organization_id]': input.organizationId,
      'line_items[0][price]': input.plan === 'individual' ? catalog.individualPriceId : catalog.teamBasePriceId,
      'line_items[0][quantity]': 1, allow_promotion_codes: true,
      'metadata[karmax_plan]': input.plan, 'metadata[karmax_seats]': input.seats,
    };
    if (input.plan === 'team' && additionalTeamUsers > 0) {
      params['line_items[1][price]'] = catalog.teamSeatPriceId;
      params['line_items[1][quantity]'] = additionalTeamUsers;
    }
    return this.request('/v1/checkout/sessions', params, input.idempotencyKey);
  }

  async resumeCheckout(input: Parameters<NonNullable<SubscriptionProvider['resumeCheckout']>>[0]) {
    const path = `/v1/checkout/sessions/${encodeURIComponent(input.checkoutId)}`;
    const session = await this.request(path, {}, input.idempotencyKey, 'GET');
    if (session.status === 'expired') return null;
    if (session.status !== 'open') throw new BillingRequestRejected('Stripe is processing checkout; wait for subscription confirmation');
    if (session.customer !== input.customerId) throw new BillingRequestRejected('Stripe checkout customer does not match');
    if (session.metadata?.karmax_plan === input.plan && Number(session.metadata?.karmax_seats) === input.seats)
      return { id: session.id, url: session.url };
    await this.request(`${path}/expire`, {}, `${input.idempotencyKey}:expire`);
    return null;
  }

  createPortal(input: { customerId: string; returnUrl: string; idempotencyKey: string }) {
    return this.request('/v1/billing_portal/sessions', { customer: input.customerId,
      return_url: input.returnUrl }, input.idempotencyKey);
  }

  async changePlan(input: { subscriptionId: string; plan: PaidHostedPlanId; seats: number;
    items: Record<string, string>; idempotencyKey: string }) {
    const catalog = (await this.requireCatalog());
    const additionalTeamUsers = Math.max(0, input.seats - HOSTED_PLANS.team.includedActiveUsers);
    const params: Record<string, string | number | boolean> = { proration_behavior: 'create_prorations' };
    const baseItem = input.items.individual || input.items.teamBase;
    if (!baseItem) throw new Error('the verified subscription item is unavailable; retry after billing reconciliation');
    params['items[0][id]'] = baseItem;
    params['items[0][price]'] = input.plan === 'individual' ? catalog.individualPriceId : catalog.teamBasePriceId;
    params['items[0][quantity]'] = 1;
    if (input.plan === 'individual' && input.items.teamSeat) {
      params['items[1][id]'] = input.items.teamSeat;
      params['items[1][deleted]'] = true;
    } else if (input.plan === 'team' && additionalTeamUsers > 0) {
      if (input.items.teamSeat) params['items[1][id]'] = input.items.teamSeat;
      params['items[1][price]'] = catalog.teamSeatPriceId;
      params['items[1][quantity]'] = additionalTeamUsers;
    }
    return this.request(`/v1/subscriptions/${encodeURIComponent(input.subscriptionId)}`, params, input.idempotencyKey);
  }

  cancelAtPeriodEnd(input: { subscriptionId: string; idempotencyKey: string }) {
    return this.request(`/v1/subscriptions/${encodeURIComponent(input.subscriptionId)}`,
      { cancel_at_period_end: true }, input.idempotencyKey);
  }

  async updateSeats(input: { subscriptionId: string; seatItemId?: string; seats: number; idempotencyKey: string }) {
    const catalog = (await this.requireCatalog());
    const additionalTeamUsers = Math.max(0, input.seats - HOSTED_PLANS.team.includedActiveUsers);
    const params: Record<string, string | number | boolean> = { proration_behavior: 'create_prorations' };
    if (input.seatItemId) params['items[0][id]'] = input.seatItemId;
    params['items[0][price]'] = catalog.teamSeatPriceId;
    if (additionalTeamUsers === 0 && input.seatItemId) params['items[0][deleted]'] = true;
    else params['items[0][quantity]'] = Math.max(1, additionalTeamUsers);
    return this.request(`/v1/subscriptions/${encodeURIComponent(input.subscriptionId)}`, params, input.idempotencyKey);
  }

  async verifyWebhook(raw: Buffer, signature?: string): Promise<BillingEvent> {
    const secret = (await this.webhookSecret());
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

  private async secretKey(): Promise<string | undefined> { return (await this.config()).secretKey?.trim(); }
  private async webhookSecret(): Promise<string | undefined> { return (await this.config()).webhookSecret?.trim(); }
  private async requireCatalog(): Promise<SubscriptionCatalogConfig> {
    const catalog = (await this.catalog());
    if (!catalog) throw new Error('subscription price identifiers are not configured');
    return catalog;
  }
  private async request(path: string, params: Record<string, string | number | boolean>, idempotencyKey: string, method = 'POST'): Promise<any> {
    const key = (await this.secretKey());
    if (!key) throw new Error('Stripe subscription billing is not configured');
    const body = new URLSearchParams();
    for (const [name, value] of Object.entries(params)) body.set(name, String(value));
    const response = await this.fetcher(`https://api.stripe.com${path}`, { method, ...(method === 'POST' ? { body } : {}),
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/x-www-form-urlencoded',
        'idempotency-key': idempotencyKey, 'stripe-version': STRIPE_BILLING_API_VERSION } });
    const payload = await response.json().catch(() => ({})) as any;
    if (!response.ok) throw new Error(payload?.error?.message || `Stripe Billing returned HTTP ${response.status}`);
    return payload;
  }
}

export class SubscriptionBillingService {
  constructor(private store: Store, private providerSource: SubscriptionProvider | ((name?: string) => Promise<SubscriptionProvider>), private hosted: boolean,
    private pastDueGraceMs = PAST_DUE_GRACE_MS) {}

  private async provider(name?: string): Promise<SubscriptionProvider> {
    const provider = typeof this.providerSource === 'function' ? await this.providerSource(name) : this.providerSource;
    if (name && name !== provider.name) throw new Error(`billing provider ${name} is unavailable`);
    return provider;
  }

  /** Attribute a subscription to its checkout initiator, never to all owners or
   * to a matching email address. Unfinished checkouts and gifts are not purchases.
   * Keep this a local read: opening a profile must not contact the payment API. */
  async paidSubscriptionsForUser(userId: string) {
    if (!this.hosted) return [];
    const rows = await this.store.db.prepare(`SELECT DISTINCT a.organizationId, a.plan, a.status,
        a.cancelAtPeriodEnd, a.currentPeriodEnd
      FROM policy_acceptances p
      JOIN subscription_billing_checkouts c ON c.checkoutId=p.checkoutSessionReference
        AND c.organizationId=p.organizationId
      JOIN subscription_billing_accounts a ON a.organizationId=c.organizationId
        AND a.provider=c.provider AND a.subscriptionId=c.subscriptionId
      WHERE p.userId=? AND p.context='checkout' AND c.state='associated'
        AND a.verifiedAt IS NOT NULL AND a.plan!='free'
        AND a.status IN ('active','trialing','past_due','unpaid','paused','canceled')
        AND NOT EXISTS (SELECT 1 FROM policy_acceptances earlier
          WHERE earlier.organizationId=p.organizationId AND earlier.context='checkout'
            AND earlier.checkoutSessionReference=p.checkoutSessionReference
            AND (earlier.acceptedAt<p.acceptedAt OR (earlier.acceptedAt=p.acceptedAt AND earlier.id<p.id)))
      ORDER BY a.organizationId`).all(userId) as Array<{
        organizationId: string; plan: PaidHostedPlanId; status: SubscriptionStatus;
        cancelAtPeriodEnd: number; currentPeriodEnd: number | null;
      }>;
    return rows.map(row => ({ organizationId: row.organizationId, plan: row.plan,
      planName: HOSTED_PLANS[row.plan].name, status: row.status,
      cancelAtPeriodEnd: Boolean(row.cancelAtPeriodEnd), currentPeriodEnd: row.currentPeriodEnd }));
  }

  async hasPaidSubscription(organizationId: string) {
    if (!this.hosted) return false;
    const account = await this.account(organizationId);
    return Boolean(account?.subscriptionId && account.verifiedAt && account.plan !== 'free'
      && ['active', 'trialing', 'past_due'].includes(account.status));
  }

  async current(organizationId: string) {
    const members = (await this.store.listOrganizationMemberships(organizationId)).length;
    if (!this.hosted) return { managed: false, providerConfigured: false, plan: 'self_hosted', status: 'unmetered',
      seats: null, activeUsers: members, seatDeficit: 0, access: 'unmetered', cancelAtPeriodEnd: false,
      catalog: Object.values(HOSTED_PLANS) };
    const account = (await this.account(organizationId));
    const provider = await this.provider(account?.provider);
    const plan = (await this.store.organizationEntitlements(organizationId)).plan ?? 'free';
    const gift = await this.currentGift(organizationId);
    const billedPlan = account?.plan ?? 'free';
    const status = account?.status ?? 'none';
    const seats = billedPlan === 'team' ? account?.seats ?? HOSTED_PLANS.team.includedActiveUsers
      : HOSTED_PLANS.individual.includedActiveUsers;
    const graceEndsAt = status === 'past_due' && account?.pastDueAt
      ? account.pastDueAt + this.pastDueGraceMs : undefined;
    const access = gift || ['active', 'trialing'].includes(status) ? 'active'
      : status === 'past_due' && graceEndsAt && graceEndsAt > Date.now() ? 'grace'
        : status === 'none' || status === 'canceled' ? 'free' : 'restricted';
    const pendingRequest = Boolean(await this.store.db.prepare('SELECT requestKey FROM subscription_billing_locks WHERE organizationId=?').get(organizationId));
    const pendingCheckout = Boolean(await this.store.db.prepare("SELECT checkoutId FROM subscription_billing_checkouts WHERE organizationId=? AND state='pending'").get(organizationId));
    return { managed: true, providerConfigured: (await provider.configured()), plan, billedPlan, status, seats, gift, pendingRequest, pendingCheckout,
      activeUsers: members, seatDeficit: gift?.plan === 'team' ? 0 : plan === 'team' ? Math.max(0, members - seats)
        : Math.max(0, members - HOSTED_PLANS[plan].includedActiveUsers),
      access, cancelAtPeriodEnd: account?.cancelAtPeriodEnd ?? false,
      currentPeriodEnd: account?.currentPeriodEnd, verifiedAt: account?.verifiedAt,
      graceEndsAt, lastError: account?.lastError, catalog: Object.values(HOSTED_PLANS) };
  }

  /** Complimentary access is independent of the provider ledger. A gift never
   * downgrades paid access or changes an existing financial contract. */
  async gift(organizationId: string, plan: unknown, grantedBy: string, key: string) {
    if (!this.hosted) throw new Error('subscription gifts are only available on hosted installations');
    this.requireKey(key);
    if (plan !== null && !isPaidHostedPlanId(plan)) throw new Error('choose Individual or Team, or null to remove the gift');
    return this.store.transaction(async () => {
      if (!(await this.store.getOrganization(organizationId))) throw new Error('organization not found');
      return this.idempotent(organizationId, `gift:${plan}`, key, async () => {
        if (plan === null) {
          await this.store.db.prepare('DELETE FROM subscription_gifts WHERE organizationId=?').run(organizationId);
        } else {
          await this.store.db.prepare(`INSERT INTO subscription_gifts (organizationId, plan, grantedBy, grantedAt)
            VALUES (?, ?, ?, ?) ON CONFLICT(organizationId) DO UPDATE SET
            plan=excluded.plan, grantedBy=excluded.grantedBy, grantedAt=excluded.grantedAt`)
            .run(organizationId, plan, grantedBy, Date.now());
        }
        const account = await this.account(organizationId);
        await this.reconcileOrganization(organizationId, account);
        return this.current(organizationId);
      });
    });
  }

  async currentGift(organizationId: string): Promise<SubscriptionGift | null> {
    const row = await this.store.db.prepare('SELECT plan, grantedBy, grantedAt FROM subscription_gifts WHERE organizationId=?')
      .get(organizationId) as SubscriptionGift | undefined;
    return row ?? null;
  }

  /** Re-applies effective plans from the last verified provider state. The main
   * process schedules this so past-due grace expires without another webhook. */
  async reconcileEntitlements(now = Date.now()): Promise<void> {
    if (!this.hosted) return;
    const rows = (await this.store.db.prepare('SELECT * FROM subscription_billing_accounts').all()) as any[];
    const errors: unknown[] = [];
    for (const row of rows) {
      try { await this.reconcileAccount(rowAccount(row)!, now); }
      catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Some subscription entitlements could not be reconciled');
  }

  async checkout(organizationId: string, plan: unknown, urls: { success: string; cancel: string }, key: string): Promise<SubscriptionCheckoutResult> {
    const provider = await this.requireHosted(); this.requireKey(key);
    if (!isPaidHostedPlanId(plan)) throw new Error('choose Individual or Team');
    const current = (await this.account(organizationId));
    if (current && current.provider !== provider.name)
      throw new Error('this organization has a billing account with another provider; reconcile it before switching');
    if (current?.subscriptionId && !['none', 'canceled', 'incomplete_expired'].includes(current.status))
      throw new Error('use Change plan for an existing subscription');
    if (!(await this.store.getOrganization(organizationId))) throw new Error('organization not found');
    const activeUsers = (await this.store.listOrganizationMemberships(organizationId)).length;
    const definition = HOSTED_PLANS[plan];
    if (definition.maxMembers != null && activeUsers > definition.maxMembers)
      throw new Error(`remove additional active users before choosing ${definition.name}`);
    const seats = Math.max(definition.includedActiveUsers, activeUsers);
    const checkoutResult = { organizationId, plan, commercialTerms: {
      planId: plan, planName: definition.name, currency: 'usd' as const, billingInterval: 'month' as const,
      monthlyBasePriceCents: definition.monthlyBasePriceCents, includedActiveUsers: definition.includedActiveUsers,
      monthlyAdditionalActiveUserPriceCents: definition.monthlyAdditionalActiveUserPriceCents, activeUsers,
      monthlyTotalPriceCents: hostedMonthlyPriceCents(plan, activeUsers),
    }, checkoutRequestReference: key, checkoutProvider: provider.name };
    const intent: BillingRequestIntent = { kind: 'checkout', plan, seats, successUrl: urls.success, checkoutResult };
    return this.idempotent(organizationId, `checkout:${plan}`, key, async (reference) => {
      const latest = await this.account(organizationId);
      if (latest && (latest.provider !== provider.name || latest.subscriptionId && !['none', 'canceled', 'incomplete_expired'].includes(latest.status)))
        throw new BillingRequestRejected('billing state changed; refresh before starting checkout');
      const customerId = await this.ensureCustomer(organizationId, `${key}:customer`, provider);
      const input = { organizationId, customerId, plan, seats,
        successUrl: urls.success, cancelUrl: urls.cancel, idempotencyKey: `${provider.supportsIdempotency === false ? reference : key}:checkout` };
      const pending = provider.resumeCheckout ? await this.store.db.prepare(`SELECT checkoutId FROM subscription_billing_checkouts
        WHERE provider=? AND organizationId=? AND state='pending' ORDER BY createdAt DESC LIMIT 1`)
        .get(provider.name, organizationId) as { checkoutId: string } | undefined : undefined;
      if (pending) {
        intent.checkoutId = pending.checkoutId;
        await this.store.db.prepare('UPDATE subscription_billing_locks SET intentJson=? WHERE organizationId=? AND requestKey=?')
          .run(JSON.stringify(intent), organizationId, key);
      }
      let session = pending ? await provider.resumeCheckout!({ ...input, checkoutId: pending.checkoutId }) : null;
      if (pending && !session) await this.store.db.prepare("UPDATE subscription_billing_checkouts SET state='canceled' WHERE provider=? AND checkoutId=?")
        .run(provider.name, pending.checkoutId);
      session ??= await provider.createCheckout(input);
      await this.store.db.prepare(`INSERT OR IGNORE INTO subscription_billing_checkouts
        (provider, checkoutId, organizationId, createdAt, state) VALUES (?, ?, ?, ?, ?)`)
        .run(provider.name, session.id, organizationId, Date.now(), provider.resumeCheckout ? 'pending' : 'unverified');
      return { ...checkoutResult, checkoutSessionReference: session.id, url: session.url };
    }, provider, intent);
  }

  async portal(organizationId: string, returnUrl: string, key: string) {
    const account = await this.account(organizationId);
    const provider = await this.requireHosted(account?.provider); this.requireKey(key);
    const customerId = account?.customerId;
    if (!customerId && !account?.subscriptionId) throw new Error('no billing account exists for this organization');
    if (provider.customerMode === 'checkout') return provider.createPortal({ customerId: customerId ?? '',
      subscriptionId: account?.subscriptionId, returnUrl, idempotencyKey: `${key}:portal` });
    return this.idempotent(organizationId, 'portal', key,
      () => provider.createPortal({ customerId: customerId!, returnUrl, idempotencyKey: `${key}:portal` }), provider);
  }

  async changePlan(organizationId: string, plan: unknown, key: string) {
    this.requireKey(key);
    if (!isPaidHostedPlanId(plan)) throw new Error('choose Individual or Team');
    const account = (await this.account(organizationId));
    const provider = await this.requireHosted(account?.provider);
    if (!account?.subscriptionId || !['active', 'trialing', 'past_due'].includes(account.status))
      throw new Error('there is no changeable subscription');
    const seats = Math.max(HOSTED_PLANS[plan].includedActiveUsers,
      (await this.store.listOrganizationMemberships(organizationId)).length);
    if (plan === 'individual' && HOSTED_PLANS.individual.maxMembers != null
      && seats > HOSTED_PLANS.individual.maxMembers)
      throw new Error('remove additional active users before downgrading to Individual');
    return this.idempotent(organizationId, `change:${plan}`, key, () => provider.changePlan({
      subscriptionId: account.subscriptionId!, plan, seats, items: account.items, idempotencyKey: `${key}:change`,
    }), provider, { kind: 'change', subscriptionId: account.subscriptionId, plan, seats });
  }

  async cancel(organizationId: string, key: string) {
    this.requireKey(key);
    const account = (await this.account(organizationId));
    const provider = await this.requireHosted(account?.provider);
    if (provider.cancelCheckout && (!account?.subscriptionId || ['none', 'canceled', 'incomplete_expired'].includes(account.status))) {
      const pending = await this.store.db.prepare("SELECT checkoutId FROM subscription_billing_checkouts WHERE organizationId=? AND provider=? AND state='pending' ORDER BY createdAt DESC LIMIT 1")
        .get(organizationId, provider.name) as { checkoutId: string } | undefined;
      if (pending) return this.idempotent(organizationId, 'cancel', key, async () => {
        const result = await provider.cancelCheckout!(pending.checkoutId);
        await this.store.db.prepare("UPDATE subscription_billing_checkouts SET state='canceled' WHERE organizationId=? AND checkoutId=? AND provider=?")
          .run(organizationId, pending.checkoutId, provider.name);
        return result;
      }, provider, { kind: 'abandon', checkoutId: pending.checkoutId });
    }
    if (!account?.subscriptionId || !['active', 'trialing', 'past_due'].includes(account.status))
      throw new Error('there is no cancellable subscription');
    return this.idempotent(organizationId, 'cancel', key, () => provider.cancelAtPeriodEnd({
      subscriptionId: account.subscriptionId!, idempotencyKey: `${key}:cancel`,
    }), provider, { kind: 'cancel', subscriptionId: account.subscriptionId });
  }

  async syncSeats(organizationId: string): Promise<void> {
    if (!this.hosted) return;
    const account = (await this.account(organizationId));
    if (!account?.subscriptionId || account.plan !== 'team' || !['active', 'trialing', 'past_due'].includes(account.status)) return;
    const seats = Math.max(HOSTED_PLANS.team.includedActiveUsers,
      (await this.store.listOrganizationMemberships(organizationId)).length);
    if (seats === account.seats) return;
    const provider = await this.requireHosted(account.provider);
    const key = `seat-sync:${organizationId}:${seats}:${account.lastEventAt}`;
    await this.idempotent(organizationId, `seats:${seats}`, key, () => provider.updateSeats({ subscriptionId: account.subscriptionId!,
      seatItemId: account.items.teamSeat, seats,
      idempotencyKey: key }), provider, { kind: 'seats', subscriptionId: account.subscriptionId, plan: 'team', seats });
  }

  /** Read-only provider recovery: never repeat an uncertain financial write.
   * If its result cannot be proven, retain the reservation for operator review. */
  async reconcilePending(organizationId: string) {
    const account = await this.account(organizationId);
    const provider = await this.requireHosted(account?.provider);
    const lock = await this.store.db.prepare('SELECT * FROM subscription_billing_locks WHERE organizationId=?')
      .get(organizationId) as any;
    if (!lock) return { reconciled: true, pending: false };
    if (!provider.reconcileRequest || !lock.intentJson || Date.now() - Number(lock.createdAt) < 60_000)
      throw new Error('billing request is still in progress or requires operator reconciliation');
    const intent = JSON.parse(lock.intentJson) as BillingRequestIntent;
    const result = await provider.reconcileRequest(intent, lock.providerReference, Number(lock.createdAt));
    if (!result) return { reconciled: false, pending: true };
    return this.store.transaction(async () => {
      const current = await this.store.db.prepare('SELECT requestKey FROM subscription_billing_locks WHERE organizationId=?').get(organizationId) as any;
      if (current?.requestKey !== lock.requestKey) return { reconciled: true, pending: false };
      if (intent.kind === 'checkout') {
        await this.store.db.prepare(`INSERT OR IGNORE INTO subscription_billing_checkouts
          (provider, checkoutId, organizationId, createdAt) VALUES (?, ?, ?, ?)`)
          .run(provider.name, result.id, organizationId, Number(lock.createdAt));
      }
      if (intent.kind === 'abandon') await this.store.db.prepare("UPDATE subscription_billing_checkouts SET state='canceled' WHERE organizationId=? AND checkoutId=? AND provider=?")
        .run(organizationId, result.id, provider.name);
      const response = intent.kind === 'checkout' ? { ...intent.checkoutResult, checkoutSessionReference: result.id, url: result.url } : { id: result.id };
      await this.store.db.prepare('UPDATE subscription_billing_requests SET responseJson=? WHERE requestKey=? AND organizationId=? AND responseJson IS NULL')
        .run(JSON.stringify(response), lock.requestKey, organizationId);
      await this.store.db.prepare('DELETE FROM subscription_billing_locks WHERE organizationId=? AND requestKey=?').run(organizationId, lock.requestKey);
      return { reconciled: true, pending: false };
    });
  }

  /** Organization metadata must retain the tenant mapping until a signed
   * provider event says the associated subscription is terminal. */
  async assertOrganizationDeletionAllowed(organizationId: string): Promise<void> {
    if (!this.hosted) return;
    if (await this.store.db.prepare('SELECT requestKey FROM subscription_billing_locks WHERE organizationId=?').get(organizationId))
      throw new Error('a billing request requires provider reconciliation before deleting this organization');
    if (await this.store.db.prepare("SELECT checkoutId FROM subscription_billing_checkouts WHERE organizationId=? AND state='pending'").get(organizationId))
      throw new Error('an uncompleted Paddle checkout must be reconciled before deleting this organization');
    const account = (await this.account(organizationId));
    if (!account?.subscriptionId) return;
    if ((TERMINAL_PROVIDER_SUBSCRIPTION_STATUSES as readonly SubscriptionStatus[]).includes(account.status)) return;
    throw new Error(`the provider subscription is ${account.status}; cancel it and wait for signed terminal confirmation before deleting this organization`);
  }

  async handleWebhook(raw: Buffer, signature?: string, providerName?: string): Promise<{ duplicate: boolean }> {
    // The original endpoint is permanently Stripe's, even after new checkouts
    // move to Paddle. Fixed-provider installations/test harnesses retain their
    // explicit adapter; dynamic routing must never infer this from settings.
    const provider = await this.requireHosted(providerName
      ?? (typeof this.providerSource === 'function' ? 'stripe-billing' : undefined));
    const event = (await provider.verifyWebhook(raw, signature));
    return this.store.transaction(async () => {
      const claim = await this.store.db.prepare(`INSERT OR IGNORE INTO subscription_billing_events
        (provider, eventId, type, createdAt, processedAt) VALUES (?, ?, ?, ?, NULL)`)
        .run(provider.name, event.id, event.type, event.created * 1000);
      if (Number(claim.changes) === 0) return { duplicate: true };
      await this.applyEvent(event, provider);
      await this.store.db.prepare('UPDATE subscription_billing_events SET processedAt=? WHERE provider=? AND eventId=?')
        .run(Date.now(), provider.name, event.id);
      return { duplicate: false };
    });
  }

  private async applyEvent(event: BillingEvent, provider: SubscriptionProvider): Promise<void> {
    if (event.type === 'ignored') return;
    const object = event.data.object;
    const customerId = stringId(object.customer);
    const subscriptionId = event.type.startsWith('customer.subscription.') ? String(object.id)
      : event.type.startsWith('invoice.') ? invoiceSubscriptionId(object)
        : stringId(object.subscription);
    let account = subscriptionId ? await this.accountBySubscription(subscriptionId) : undefined;
    if (provider.customerMode === 'checkout') {
      if (!account && event.checkoutId) {
        const checkout = await this.store.db.prepare('SELECT organizationId FROM subscription_billing_checkouts WHERE provider=? AND checkoutId=?')
          .get(provider.name, event.checkoutId) as { organizationId: string } | undefined;
        if (checkout) account = await this.account(checkout.organizationId);
      }
      // A subscription.updated can arrive before subscription.created. Retry it
      // rather than permanently acknowledging an unassociated state change.
      if (!account && !event.checkoutId) {
        // Old subscriptions keep their binding after a tenant resubscribes.
        // Their delayed events must not affect the replacement subscription.
        if (await this.store.db.prepare('SELECT checkoutId FROM subscription_billing_checkouts WHERE provider=? AND subscriptionId=?')
          .get(provider.name, subscriptionId ?? '')) return;
        throw new Error('Paddle subscription association is pending; retry delivery');
      }
      if (account?.subscriptionId && account.subscriptionId !== subscriptionId
        && (!event.checkoutId || !['canceled', 'incomplete_expired'].includes(account.status))) return;
    } else if (!account && customerId) account = await this.accountByCustomer(customerId);
    if (account && account.provider !== provider.name) return;
    if (provider.customerMode !== 'checkout' && account) {
      const completed = event.type === 'checkout.session.completed'
        ? await this.store.db.prepare('SELECT checkoutId FROM subscription_billing_checkouts WHERE provider=? AND checkoutId=? AND organizationId=?')
          .get(provider.name, String(object.id), account.organizationId) : undefined;
      if (event.type === 'checkout.session.completed' && !completed) return;
      if (account.subscriptionId && account.subscriptionId !== subscriptionId) {
        if (!completed || !['canceled', 'incomplete_expired'].includes(account.status)) return;
      }
    }
    if (!account) return; // Never adopt a tenant association from provider metadata.
    if (provider.customerMode === 'checkout' && event.checkoutId && subscriptionId)
      await this.store.db.prepare("UPDATE subscription_billing_checkouts SET subscriptionId=?, state='associated' WHERE provider=? AND checkoutId=? AND organizationId=?")
        .run(subscriptionId, provider.name, event.checkoutId, account.organizationId);
    // Association is independent of the entitlement clock: a checkout event
    // can legitimately arrive after a newer subscription snapshot.
    if (event.type === 'checkout.session.completed' && subscriptionId)
      await this.store.db.prepare("UPDATE subscription_billing_checkouts SET subscriptionId=?, state='associated' WHERE provider=? AND checkoutId=? AND organizationId=?")
        .run(subscriptionId, provider.name, String(object.id), account.organizationId);
    const eventAt = event.created * 1000;
    if (eventAt < account.lastEventAt) return;
    if (event.type === 'checkout.session.completed') {
      // This event associates the provider subscription but carries no verified
      // line-item snapshot. Do not advance the reconciliation clock: Stripe may
      // deliver the slightly older subscription.created event afterwards.
      if (subscriptionId) {
        await this.patchAccount(account.organizationId, { subscriptionId });
      }
      return;
    }
    if (event.type.startsWith('customer.subscription.')) {
      if (event.type === 'customer.subscription.deleted') {
        const rank = billingEventRank(event.type, 'canceled');
        const next = { status: 'canceled' as const, plan: account.plan,
          seats: HOSTED_PLANS[account.plan].includedActiveUsers, cancelAtPeriodEnd: false };
        if (!shouldApplyBillingTransition(account, eventAt, rank, next)) return;
        const updated = (await this.patchAccount(account.organizationId, { subscriptionId, status: 'canceled',
          seats: HOSTED_PLANS[account.plan].includedActiveUsers,
          items: {}, cancelAtPeriodEnd: false, currentPeriodEnd: subscriptionPeriodEnd(object),
          lastEventAt: eventAt, lastEventRank: rank, verifiedAt: Date.now(), pastDueAt: undefined }));
        (await this.reconcileAccount(updated));
        return;
      }
      const mapped = (await this.mapSubscription(object, provider));
      const status = normalizeStatus(object.status);
      const rank = billingEventRank(event.type, status);
      const cancelAtPeriodEnd = Boolean(object.cancel_at_period_end);
      if (!shouldApplyBillingTransition(account, eventAt, rank,
        { status, plan: mapped.plan, seats: mapped.seats, cancelAtPeriodEnd })) return;
      const updated = (await this.patchAccount(account.organizationId, { subscriptionId: String(object.id), ...mapped,
        status, cancelAtPeriodEnd,
        currentPeriodEnd: subscriptionPeriodEnd(object), lastEventAt: eventAt, lastEventRank: rank,
        verifiedAt: Date.now(), pastDueAt: status === 'past_due' ? account.pastDueAt ?? Date.now() : undefined,
        lastError: undefined }));
      (await this.reconcileAccount(updated));
      return;
    }
    if (event.type === 'invoice.payment_failed'
      && ['active', 'trialing', 'past_due'].includes(account.status)) {
      const rank = billingEventRank(event.type, 'past_due');
      if (!shouldApplyBillingTransition(account, eventAt, rank,
        { status: 'past_due', plan: account.plan, seats: account.seats,
          cancelAtPeriodEnd: account.cancelAtPeriodEnd })) return;
      const updated = (await this.patchAccount(account.organizationId, { status: 'past_due',
        pastDueAt: account.pastDueAt ?? Date.now(), lastError: 'The latest subscription payment failed.',
        lastEventAt: eventAt, lastEventRank: rank, verifiedAt: Date.now() }));
      (await this.reconcileAccount(updated));
    } else if (event.type === 'invoice.paid'
      && ['active', 'trialing', 'past_due', 'unpaid'].includes(account.status)) {
      const rank = billingEventRank(event.type, 'active');
      if (!shouldApplyBillingTransition(account, eventAt, rank,
        { status: 'active', plan: account.plan, seats: account.seats,
          cancelAtPeriodEnd: account.cancelAtPeriodEnd })) return;
      const updated = (await this.patchAccount(account.organizationId, { status: 'active', pastDueAt: undefined,
        lastError: undefined, lastEventAt: eventAt, lastEventRank: rank, verifiedAt: Date.now() }));
      (await this.reconcileAccount(updated));
    }
  }

  private effectivePlan(account: BillingAccount, now: number): HostedPlanId {
    if (!account.verifiedAt) return 'free';
    if (account.status === 'active' || account.status === 'trialing') return account.plan;
    if (account.status === 'past_due' && account.pastDueAt
      && now < account.pastDueAt + this.pastDueGraceMs) return account.plan;
    return 'free';
  }

  private async reconcileAccount(account: BillingAccount, now = Date.now()): Promise<void> {
    await this.reconcileOrganization(account.organizationId, account, now);
  }

  private async reconcileOrganization(organizationId: string, account?: BillingAccount, now = Date.now()): Promise<void> {
    await this.store.transaction(async () => {
      const gift = await this.currentGift(organizationId);
      const paidPlan = account ? this.effectivePlan(account, now) : 'free';
      const plan = paidPlan === 'team' || gift?.plan === 'team' ? 'team'
        : paidPlan === 'individual' || gift?.plan === 'individual' ? 'individual' : 'free';
      if ((await this.store.getOrganization(organizationId))?.plan !== plan)
        await this.store.setOrganizationPlan(organizationId, plan);
    });
  }

  private async mapSubscription(object: any, provider: SubscriptionProvider): Promise<{ plan: HostedPlanId; seats: number; items: Record<string, string> }> {
    const currentCatalog = await provider.catalog();
    if (!currentCatalog) throw new Error('subscription catalog is not configured');
    const catalogs = await rememberSubscriptionCatalog(this.store, provider.name, currentCatalog);
    const items: Record<string, string> = {};
    let plan: HostedPlanId | undefined;
    let seats = HOSTED_PLANS.team.includedActiveUsers;
    for (const item of object.items?.data ?? []) {
      const price = stringId(item.price);
      const product = stringId(item.price?.product);
      const catalog = catalogs.find((entry) => [entry.individualPriceId, entry.teamBasePriceId, entry.teamSeatPriceId].includes(price ?? '')) ?? currentCatalog;
      if (price === catalog.individualPriceId) {
        if (provider.customerMode === 'checkout' && item.quantity !== 1) throw new Error('base plan quantity must be one');
        if (plan) throw new Error('subscription contains multiple configured base plan prices');
        if (catalog.individualProductId && product !== catalog.individualProductId)
          throw new Error('Individual price belongs to an unexpected Stripe product');
        plan = 'individual'; items.individual = String(item.id);
      } else if (price === catalog.teamBasePriceId) {
        if (provider.customerMode === 'checkout' && item.quantity !== 1) throw new Error('base plan quantity must be one');
        if (plan) throw new Error('subscription contains multiple configured base plan prices');
        if (catalog.teamProductId && product !== catalog.teamProductId)
          throw new Error('Team base price belongs to an unexpected Stripe product');
        plan = 'team'; items.teamBase = String(item.id);
      } else if (price === catalog.teamSeatPriceId) {
        if (items.teamSeat) throw new Error('subscription contains duplicate seat prices');
        if (catalog.teamProductId && product !== catalog.teamProductId)
          throw new Error('Team seat price belongs to an unexpected Stripe product');
        const quantity = Number(item.quantity);
        if (!Number.isSafeInteger(quantity) || quantity < 0) throw new Error('Team seat quantity is invalid');
        seats += quantity; items.teamSeat = String(item.id);
      } else if (provider.customerMode === 'checkout') throw new Error('Paddle subscription contains an unexpected price');
    }
    if (!plan) throw new Error('subscription contains no configured Karmax plan price');
    if (provider.customerMode === 'checkout' && plan === 'individual' && items.teamSeat)
      throw new Error('Individual subscription contains Team seats');
    return { plan, seats: plan === 'team' ? seats : HOSTED_PLANS.individual.includedActiveUsers, items };
  }

  private async account(organizationId: string): Promise<BillingAccount | undefined> {
    return rowAccount((await this.store.db.prepare('SELECT * FROM subscription_billing_accounts WHERE organizationId=?').get(organizationId)) as any);
  }
  private async accountByCustomer(customerId: string): Promise<BillingAccount | undefined> {
    return rowAccount((await this.store.db.prepare('SELECT * FROM subscription_billing_accounts WHERE customerId=?').get(customerId)) as any);
  }
  private async accountBySubscription(subscriptionId: string): Promise<BillingAccount | undefined> {
    return rowAccount((await this.store.db.prepare('SELECT * FROM subscription_billing_accounts WHERE subscriptionId=?').get(subscriptionId)) as any);
  }
  private async ensureCustomer(organizationId: string, key: string, provider: SubscriptionProvider): Promise<string> {
    const existing = (await this.account(organizationId))?.customerId;
    if (existing) return existing;
    const organization = (await this.store.getOrganization(organizationId));
    if (!organization) throw new Error('organization not found');
    const customer = provider.customerMode === 'checkout' ? { id: '' }
      : await provider.createCustomer({ organizationId, name: organization.name, idempotencyKey: key });
    const now = Date.now();
    (await this.store.db.prepare(`INSERT INTO subscription_billing_accounts
      (organizationId, provider, customerId, plan, status, seats, itemsJson, cancelAtPeriodEnd, lastEventAt, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, 'none', ?, '{}', 0, 0, ?, ?)
      ON CONFLICT(organizationId) DO UPDATE SET customerId=excluded.customerId, updatedAt=excluded.updatedAt`)
      .run(organizationId, provider.name, customer.id || null, HOSTED_PLANS.free.id,
        HOSTED_PLANS.free.includedActiveUsers, now, now));
    return customer.id;
  }
  private async patchAccount(organizationId: string, patch: Partial<BillingAccount>): Promise<BillingAccount> {
    const current = (await this.account(organizationId));
    if (!current) throw new Error('billing account not found');
    (await this.store.db.prepare(`UPDATE subscription_billing_accounts SET subscriptionId=?, plan=?, status=?, seats=?,
      itemsJson=?, currentPeriodEnd=?, cancelAtPeriodEnd=?, lastEventAt=?, lastEventRank=?, verifiedAt=?, pastDueAt=?, lastError=?, updatedAt=?
      WHERE organizationId=?`).run(patch.subscriptionId ?? current.subscriptionId ?? null,
      patch.plan ?? current.plan, patch.status ?? current.status, patch.seats ?? current.seats,
      JSON.stringify(patch.items ?? current.items), patch.currentPeriodEnd ?? current.currentPeriodEnd ?? null,
      (patch.cancelAtPeriodEnd ?? current.cancelAtPeriodEnd) ? 1 : 0, patch.lastEventAt ?? current.lastEventAt,
      patch.lastEventRank ?? current.lastEventRank,
      patch.verifiedAt ?? current.verifiedAt ?? null,
      Object.prototype.hasOwnProperty.call(patch, 'pastDueAt') ? patch.pastDueAt ?? null : current.pastDueAt ?? null,
      Object.prototype.hasOwnProperty.call(patch, 'lastError') ? patch.lastError ?? null : current.lastError ?? null,
      Date.now(), organizationId));
    return (await this.account(organizationId))!;
  }
  private async idempotent<T>(organizationId: string, operation: string, key: string, work: (reference: string) => Promise<T>, provider?: SubscriptionProvider, intent?: BillingRequestIntent): Promise<T> {
    const hash = crypto.createHash('sha256').update(`${organizationId}:${operation}`).digest('hex');
    const reference = crypto.randomUUID();
    const cached = await this.store.transaction(async () => {
    const prior = (await this.store.db.prepare('SELECT * FROM subscription_billing_requests WHERE requestKey=?').get(key)) as any;
    if (prior) {
      if (prior.organizationId !== organizationId || prior.requestHash !== hash) throw new Error('idempotency key was already used for another billing request');
      if (prior.responseJson) return { response: JSON.parse(prior.responseJson) as T };
      if (provider?.supportsIdempotency === false)
        throw new Error('billing request requires provider reconciliation before retrying');
      // A process can die after reserving the local key but before saving the
      // response. Stripe retains the same provider idempotency key, so releasing
      // only a stale local reservation resumes safely without duplicating money.
      if (Number(prior.createdAt) > Date.now() - 5 * 60_000)
        throw new Error('an identical billing request is already in progress');
      await this.store.db.prepare('DELETE FROM subscription_billing_locks WHERE organizationId=? AND requestKey=?').run(organizationId, key);
      (await this.store.db.prepare('DELETE FROM subscription_billing_requests WHERE requestKey=? AND responseJson IS NULL').run(key));
    }
    if (provider?.supportsIdempotency === false || operation.startsWith('checkout:')) {
      const pending = await this.store.db.prepare('SELECT requestKey FROM subscription_billing_requests WHERE organizationId=? AND responseJson IS NULL')
        .get(organizationId);
      if (pending) throw new Error('another billing request is in progress or requires provider reconciliation');
      const lock = await this.store.db.prepare(`INSERT OR IGNORE INTO subscription_billing_locks
        (organizationId, requestKey, intentJson, providerReference, createdAt) VALUES (?, ?, ?, ?, ?)`)
        .run(organizationId, key, intent ? JSON.stringify(intent) : null, reference, Date.now());
      if (!Number(lock.changes)) throw new Error('another billing request is in progress or requires provider reconciliation');
    }
    (await this.store.db.prepare(`INSERT INTO subscription_billing_requests
      (requestKey, organizationId, operation, requestHash, responseJson, createdAt) VALUES (?, ?, ?, ?, NULL, ?)`)
      .run(key, organizationId, operation, hash, Date.now()));
    return undefined;
    });
    if (cached) return cached.response;
    try {
      const response = await work(reference);
      await this.store.transaction(async () => {
      (await this.store.db.prepare('UPDATE subscription_billing_requests SET responseJson=? WHERE requestKey=?')
        .run(JSON.stringify(response), key));
      await this.store.db.prepare('DELETE FROM subscription_billing_locks WHERE organizationId=? AND requestKey=?').run(organizationId, key);
      });
      return response;
    } catch (error) {
      if (provider?.supportsIdempotency !== false || error instanceof BillingRequestRejected) await this.store.transaction(async () => {
        (await this.store.db.prepare('DELETE FROM subscription_billing_requests WHERE requestKey=? AND responseJson IS NULL').run(key));
        await this.store.db.prepare('DELETE FROM subscription_billing_locks WHERE organizationId=? AND requestKey=?').run(organizationId, key);
      });
      throw error;
    }
  }
  private async requireHosted(name?: string): Promise<SubscriptionProvider> {
    if (!this.hosted) throw new Error('hosted subscription billing is not used by self-hosted installations');
    const provider = await this.provider(name);
    if (!(await provider.configured())) throw new Error('hosted subscription billing is not configured');
    const catalog = await provider.catalog();
    if (catalog) await rememberSubscriptionCatalog(this.store, provider.name, catalog);
    return provider;
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
  if (!isHostedPlanId(row.plan)) throw new Error(`billing account contains unknown plan ${String(row.plan)}`);
  return { organizationId: row.organizationId, provider: row.provider, customerId: row.customerId ?? undefined,
    subscriptionId: row.subscriptionId ?? undefined, plan: row.plan, status: normalizeStatus(row.status), seats: Number(row.seats),
    items: JSON.parse(row.itemsJson || '{}'), currentPeriodEnd: row.currentPeriodEnd ?? undefined,
    cancelAtPeriodEnd: Boolean(row.cancelAtPeriodEnd), lastEventAt: Number(row.lastEventAt),
    lastEventRank: Number(row.lastEventRank || 0),
    verifiedAt: row.verifiedAt ?? undefined, pastDueAt: row.pastDueAt ?? undefined,
    lastError: row.lastError ?? undefined };
}
function stringId(value: any): string | undefined { return typeof value === 'string' ? value : value?.id ? String(value.id) : undefined; }
function epochMs(value: any): number | undefined { const n = Number(value); return Number.isFinite(n) && n > 0 ? n * 1000 : undefined; }
function invoiceSubscriptionId(invoice: any): string | undefined {
  if (invoice?.parent?.type === 'subscription_details')
    return stringId(invoice.parent.subscription_details?.subscription);
  return stringId(invoice?.subscription);
}
function subscriptionPeriodEnd(subscription: any): number | undefined {
  const legacy = epochMs(subscription?.current_period_end);
  if (legacy) return legacy;
  const itemEnds = (subscription?.items?.data ?? [])
    .map((item: any) => epochMs(item?.current_period_end))
    .filter((value: number | undefined): value is number => value !== undefined);
  // cancel_at_period_end resolves at the earliest item period when Stripe is
  // ever configured with mixed intervals. Krmax's current prices are aligned
  // monthly, but using the same boundary keeps the stored access date safe.
  return itemEnds.length ? Math.min(...itemEnds) : undefined;
}
function normalizeStatus(value: any): SubscriptionStatus {
  const status = String(value || 'incomplete') as SubscriptionStatus;
  return ['none', 'trialing', 'active', 'past_due', 'unpaid', 'incomplete', 'incomplete_expired', 'paused', 'canceled'].includes(status)
    ? status : 'incomplete';
}

/** Stripe event timestamps have one-second resolution. At a collision,
 * subscription snapshots outrank invoice summaries, terminal states are
 * sticky, and a paid invoice outranks a failed invoice. Equal snapshot ranks
 * deterministically prefer the lower-entitlement plan, cancellation intent,
 * then the larger billed seat quantity. A strictly newer event always wins. */
function billingEventRank(type: string, status: SubscriptionStatus): number {
  if (type === 'customer.subscription.deleted') return 700;
  if (type.startsWith('customer.subscription.')) return ({
    canceled: 690, incomplete_expired: 680, unpaid: 670, paused: 660,
    incomplete: 650, past_due: 640, active: 630, trialing: 620, none: 610,
  } satisfies Record<SubscriptionStatus, number>)[status];
  if (type === 'invoice.paid') return 500;
  if (type === 'invoice.payment_failed') return 400;
  return 0;
}

function shouldApplyBillingTransition(current: BillingAccount, eventAt: number, eventRank: number,
  next: Pick<BillingAccount, 'status' | 'plan' | 'seats' | 'cancelAtPeriodEnd'>): boolean {
  if (eventAt > current.lastEventAt) return true;
  if (eventAt < current.lastEventAt) return false;
  if (eventRank !== current.lastEventRank) return eventRank > current.lastEventRank;
  const planRestriction = (plan: HostedPlanId) => plan === 'free' ? 3 : plan === 'individual' ? 2 : 1;
  const before = [planRestriction(current.plan), current.cancelAtPeriodEnd ? 1 : 0, current.seats];
  const after = [planRestriction(next.plan), next.cancelAtPeriodEnd ? 1 : 0, next.seats];
  for (let index = 0; index < before.length; index++) {
    if (after[index] !== before[index]) return after[index]! > before[index]!;
  }
  return false;
}
