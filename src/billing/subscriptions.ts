import crypto from 'node:crypto';
import { rememberSubscriptionCatalog } from './catalog.js';
import type { Store } from '../store/db.js';
import { COMPUTE_PACK, HOSTED_PLANS, STORAGE_PACK, hostedMonthlyPriceCents, hostedStorageQuotaBytes, isHostedPlanId,
  type HostedPlanId } from '../domain/entitlements.js';
import { managedStorageLocationId } from '../store/storage-locations.js';
import type { SubscriptionRuntimeConfig } from '../launch/settings.js';
import { STRIPE_BILLING_API_VERSION } from './stripe-contract.js';
import { BillingRequestRejected } from './paddle.js';
import { BRAND } from '../domain/brand.js';

export type PaidHostedPlanId = Exclude<HostedPlanId, 'free'>;
const isPaidHostedPlanId = (value: unknown): value is PaidHostedPlanId =>
  isHostedPlanId(value) && value !== HOSTED_PLANS.free.id;
export const PAST_DUE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
export type SubscriptionStatus = 'none' | 'trialing' | 'active' | 'past_due' | 'unpaid'
  | 'incomplete' | 'incomplete_expired' | 'paused' | 'canceled';
export const TERMINAL_PROVIDER_SUBSCRIPTION_STATUSES = ['canceled', 'incomplete_expired'] as const;
/** How long after an uncertain billing write the provider's reads must still
 * show no effect before the write counts as never applied. */
export const ABSENT_WRITE_SETTLE_MS = 10 * 60_000;

export interface SubscriptionCatalogConfig {
  individualPriceId: string;
  teamBasePriceId: string;
  teamSeatPriceId: string;
  individualProductId?: string;
  teamProductId?: string;
  /** Optional: storage packs are offered only once their price exists. */
  storagePackPriceId?: string;
  storagePackProductId?: string;
  /** Optional: compute packs are offered only once their price exists. */
  computePackPriceId?: string;
  computePackProductId?: string;
}

/** Authoritative commercial snapshot returned by the canonical checkout service.
 * Policy acceptance is intentionally outside this billing-owned structure. */
export interface SubscriptionCommercialTerms {
  /** Null for packs alone, bought beside a gifted plan (checkoutPacks). */
  planId: PaidHostedPlanId | null;
  planName: string | null;
  currency: 'usd';
  billingInterval: 'month';
  monthlyBasePriceCents: number;
  includedActiveUsers: number;
  monthlyAdditionalActiveUserPriceCents: number;
  activeUsers: number;
  storagePacks?: number;
  computePacks?: number;
  /** Team seats bought beside a gifted Team (checkoutPacks), each billed at
   * the Team seat price. */
  seats?: number;
  monthlyTotalPriceCents: number;
}

export interface SubscriptionCheckoutResult {
  organizationId: string;
  plan: PaidHostedPlanId | null;
  commercialTerms: SubscriptionCommercialTerms;
  checkoutRequestReference: string;
  checkoutSessionReference: string;
  checkoutProvider: string;
  url: string;
}

export interface SubscriptionGift {
  plan: PaidHostedPlanId;
  /** People a gifted Team covers for nothing; more are bought beside it. */
  seats?: number;
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
  /** Verified storage packs billed on the subscription. */
  storagePacks: number;
  /** Verified compute packs billed on the subscription. */
  computePacks: number;
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
  /** A subscription of a plan and its seats, or of packs alone (no plan). */
  createCheckout(input: { organizationId: string; customerId: string; plan?: PaidHostedPlanId;
    seats: number; storagePacks?: number; computePacks?: number;
    successUrl: string; cancelUrl: string; idempotencyKey: string }): Promise<{ id: string; url: string }>;
  resumeCheckout?(input: Parameters<SubscriptionProvider['createCheckout']>[0] & { checkoutId: string }): Promise<{ id: string; url: string } | null>;
  cancelCheckout?(checkoutId: string): Promise<{ id: string }>;
  /** The recovered result, `{ absent: true }` when a complete read shows the
   * write had no effect, or null when the reads prove neither. */
  reconcileRequest?(intent: BillingRequestIntent, reference: string, createdAt: number): Promise<{ id: string; url?: string } | { absent: true } | null>;
  createPortal(input: { customerId: string; subscriptionId?: string; returnUrl: string; idempotencyKey: string }): Promise<{ url: string }>;
  changePlan(input: { subscriptionId: string; plan: PaidHostedPlanId; seats: number;
    items: Record<string, string>; idempotencyKey: string }): Promise<{ id: string }>;
  cancelAtPeriodEnd(input: { subscriptionId: string; idempotencyKey: string }): Promise<{ id: string }>;
  updateSeats(input: { subscriptionId: string; seatItemId?: string; seats: number;
    idempotencyKey: string }): Promise<{ id: string }>;
  /** Sets the subscription's total storage packs, keeping every other item. */
  updateStoragePacks(input: { subscriptionId: string; storagePacks: number; idempotencyKey: string }): Promise<{ id: string }>;
  /** Sets the subscription's total compute packs, keeping every other item. */
  updateComputePacks(input: { subscriptionId: string; computePacks: number; idempotencyKey: string }): Promise<{ id: string }>;
  /** Sets the Team seats billed on a subscription with no plan of its own,
   * beside a gifted Team, keeping every other item. */
  updateAddOnSeats?(input: { subscriptionId: string; extraSeats: number; idempotencyKey: string }): Promise<{ id: string }>;
  /** Withdraws a cancellation scheduled for the end of the period. */
  resumeSubscription?(input: { subscriptionId: string; idempotencyKey: string }): Promise<{ id: string }>;
  /** Charges a compute top-up once, now, to the subscription's saved payment
   * method (wiki features/managed-compute § Auto top-up). */
  chargeComputeTopUp?(input: { subscriptionId: string; topUpId: string; amountCents: number }): Promise<{ id: string }>;
  /** Where a top-up charge stands, from the provider's records; `absent` when
   * a complete read finds no charge, null when the reads prove nothing. */
  findComputeTopUp?(input: { subscriptionId: string; topUpId: string; since: number }): Promise<
    { state: 'paid' | 'pending' | 'declined' | 'failed'; transactionId?: string } | { absent: true } | null>;
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
  kind: 'checkout' | 'change' | 'cancel' | 'resume' | 'seats' | 'storage' | 'compute' | 'abandon';
  subscriptionId?: string;
  checkoutId?: string;
  plan?: PaidHostedPlanId;
  seats?: number;
  storagePacks?: number;
  computePacks?: number;
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

  async createCheckout(input: Parameters<SubscriptionProvider['createCheckout']>[0]) {
    if (!input.plan || input.storagePacks || input.computePacks) throw new BillingRequestRejected('packs are billed only through Paddle');
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

  resumeSubscription(input: { subscriptionId: string; idempotencyKey: string }) {
    return this.request(`/v1/subscriptions/${encodeURIComponent(input.subscriptionId)}`,
      { cancel_at_period_end: false }, input.idempotencyKey);
  }

  async updateStoragePacks(): Promise<{ id: string }> {
    throw new BillingRequestRejected('storage packs are billed only through Paddle');
  }

  async updateComputePacks(): Promise<{ id: string }> {
    throw new BillingRequestRejected('compute packs are billed only through Paddle');
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
        AND a.verifiedAt IS NOT NULL
        AND a.status IN ('active','trialing','past_due','unpaid','paused','canceled')
        AND NOT EXISTS (SELECT 1 FROM policy_acceptances earlier
          WHERE earlier.organizationId=p.organizationId AND earlier.context='checkout'
            AND earlier.checkoutSessionReference=p.checkoutSessionReference
            AND (earlier.acceptedAt<p.acceptedAt OR (earlier.acceptedAt=p.acceptedAt AND earlier.id<p.id)))
      ORDER BY a.organizationId`).all(userId) as Array<{
        organizationId: string; plan: HostedPlanId; status: SubscriptionStatus;
        cancelAtPeriodEnd: number; currentPeriodEnd: number | null;
      }>;
    return rows.map(row => ({ organizationId: row.organizationId, plan: row.plan,
      planName: row.plan === 'free' ? 'Packs' : HOSTED_PLANS[row.plan].name, status: row.status,
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
    const catalog = await provider.catalog();
    const storagePack = { ...STORAGE_PACK, available: Boolean(catalog?.storagePackPriceId) };
    const storagePackGift = await this.store.storagePackGift(organizationId);
    const computePack = { ...COMPUTE_PACK, available: Boolean(catalog?.computePackPriceId) };
    const computePackGift = await this.store.computePackGift(organizationId);
    // What the subscription bills each month: its plan and seats, and its packs.
    const billedMonthlyPriceCents = account?.subscriptionId && ['active', 'trialing', 'past_due'].includes(status)
      ? billedMonthlyCents(account) : null;
    const teamSeats = this.seatState(plan, members, account, gift);
    return { managed: true, providerConfigured: (await provider.configured()), plan, billedPlan, status, seats, gift, pendingRequest, pendingCheckout,
      billedMonthlyPriceCents,
      storagePacks: account?.storagePacks ?? 0, storagePack, storagePackGift, giftedStoragePacks: storagePackGift?.packs ?? 0,
      computePacks: account?.computePacks ?? 0, computePack, computePackGift, giftedComputePacks: computePackGift?.packs ?? 0,
      activeUsers: members, teamSeats,
      // People a paid Team still has to bill seats for (Bill seats); none
      // where nothing bills them (a gifted Team, or one the operator set).
      seatDeficit: teamSeats ? (teamSeats.autoBill ? Math.max(0, members - (teamSeats.total ?? members)) : 0)
        : Math.max(0, members - HOSTED_PLANS[plan].includedActiveUsers),
      access, cancelAtPeriodEnd: account?.cancelAtPeriodEnd ?? false,
      currentPeriodEnd: account?.currentPeriodEnd, verifiedAt: account?.verifiedAt,
      graceEndsAt, lastError: account?.lastError, catalog: Object.values(HOSTED_PLANS) };
  }

  /** Complimentary access is independent of the provider ledger. A gift never
   * downgrades paid access or changes an existing financial contract. */
  async gift(organizationId: string, plan: unknown, grantedBy: string, key: string, seats?: unknown) {
    if (!this.hosted) throw new Error('subscription gifts are only available on hosted installations');
    this.requireKey(key);
    if (plan !== null && !isPaidHostedPlanId(plan)) throw new Error('choose Individual or Team, or null to remove the gift');
    if (seats !== undefined && seats !== null && (typeof seats !== 'number' || !Number.isSafeInteger(seats) || seats < 1 || seats > MAX_SEATS))
      throw new Error(`gifted seats must be a whole number from 1 to ${MAX_SEATS}`);
    return this.store.transaction(async () => {
      await this.store.lock(`org:${organizationId}`);
      if (!(await this.store.getOrganization(organizationId))) throw new Error('organization not found');
      return this.idempotent(organizationId, `gift:${plan}:${seats ?? ''}`, key, async () => {
        if (plan === null) {
          await this.store.db.prepare('DELETE FROM subscription_gifts WHERE organizationId=?').run(organizationId);
        } else {
          // A gifted Team covers the seats asked for; else the ones it covered
          // before, else the people there now (at least the one Team includes).
          const before = await this.currentGift(organizationId);
          const members = (await this.store.listOrganizationMemberships(organizationId)).length;
          const covered = plan !== 'team' ? null : typeof seats === 'number' ? seats
            : before?.plan === 'team' && before.seats ? before.seats : Math.max(HOSTED_PLANS.team.includedActiveUsers, members);
          await this.store.db.prepare(`INSERT INTO subscription_gifts (organizationId, plan, seats, grantedBy, grantedAt)
            VALUES (?, ?, ?, ?, ?) ON CONFLICT(organizationId) DO UPDATE SET
            plan=excluded.plan, seats=excluded.seats, grantedBy=excluded.grantedBy, grantedAt=excluded.grantedAt`)
            .run(organizationId, plan, covered, grantedBy, Date.now());
        }
        await this.reconcileOrganization(organizationId);
        return this.current(organizationId);
      });
    });
  }

  /** Complimentary storage packs, like a gifted plan: independent of the
   * provider ledger, counted on any plan, kept until removed (0 removes). */
  async giftStoragePacks(organizationId: string, packs: unknown, grantedBy: string, key: string) {
    if (!this.hosted) throw new Error('storage pack gifts are only available on hosted installations');
    this.requireKey(key);
    if (typeof packs !== 'number' || !Number.isSafeInteger(packs) || packs < 0 || packs > 1000)
      throw new Error('gifted storage packs must be a whole number from 0 to 1000');
    return this.store.transaction(async () => {
      if (!(await this.store.getOrganization(organizationId))) throw new Error('organization not found');
      return this.idempotent(organizationId, `gift-storage:${packs}`, key, async () => {
        await this.store.setStoragePackGift(organizationId, packs, grantedBy);
        return this.current(organizationId);
      });
    });
  }

  /** Complimentary compute packs, like gifted storage packs: counted on any
   * plan (the operator's way to offer a trial), kept until removed (0 removes). */
  async giftComputePacks(organizationId: string, packs: unknown, grantedBy: string, key: string) {
    if (!this.hosted) throw new Error('compute pack gifts are only available on hosted installations');
    this.requireKey(key);
    if (typeof packs !== 'number' || !Number.isSafeInteger(packs) || packs < 0 || packs > 1000)
      throw new Error('gifted compute packs must be a whole number from 0 to 1000');
    return this.store.transaction(async () => {
      if (!(await this.store.getOrganization(organizationId))) throw new Error('organization not found');
      return this.idempotent(organizationId, `gift-compute:${packs}`, key, async () => {
        await this.store.setComputePackGift(organizationId, packs, grantedBy);
        return this.current(organizationId);
      });
    });
  }

  async currentGift(organizationId: string): Promise<SubscriptionGift | null> {
    const row = await this.store.db.prepare('SELECT plan, seats, grantedBy, grantedAt FROM subscription_gifts WHERE organizationId=?')
      .get(organizationId) as (Omit<SubscriptionGift, 'seats'> & { seats: number | string | null }) | undefined;
    if (!row) return null;
    const { seats, ...gift } = row;
    return { ...gift, grantedAt: Number(gift.grantedAt), ...(row.plan === 'team' && seats != null ? { seats: Number(seats) } : {}) };
  }

  /** The seats a Team covers: a paid Team's (one included, more at the seat
   * price), or a gifted Team's gifted seats and those bought beside it.
   * `limit` is how many people may be members (null: anyone may join, as on
   * a paid Team, whose next person is billed a seat). Null off Team. */
  private seatState(plan: HostedPlanId, members: number, account: BillingAccount | undefined,
    gift: SubscriptionGift | null, now = Date.now()): TeamSeats | null {
    if (plan !== 'team') return null;
    const paid = account ? this.paidFor(account, now) : false;
    const billedTeam = paid && account!.plan === 'team';
    const extra = paid ? billedExtraSeats(account!) : 0;
    const gifted = gift?.plan === 'team' ? Math.max(1, gift.seats ?? members) : 0;
    const included = gifted || (billedTeam ? HOSTED_PLANS.team.includedActiveUsers : 0);
    // A Team the operator set directly has no seats to count.
    const total = included ? included + extra : null;
    return { total, used: members, gifted, paid: extra, included, limit: billedTeam ? null : total,
      autoBill: billedTeam, priceCents: HOSTED_PLANS.team.monthlyAdditionalActiveUserPriceCents };
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
    await this.assertNoSubscription(organizationId, provider, 'use Change plan for an existing subscription');
    const activeUsers = (await this.store.listOrganizationMemberships(organizationId)).length;
    const definition = HOSTED_PLANS[plan];
    if (definition.maxMembers != null && activeUsers > definition.maxMembers)
      throw new Error(`remove additional active users before choosing ${definition.name}`);
    const seats = Math.max(definition.includedActiveUsers, activeUsers);
    return this.startCheckout(organizationId, { plan, seats }, {
      planId: plan, planName: definition.name, currency: 'usd', billingInterval: 'month',
      monthlyBasePriceCents: definition.monthlyBasePriceCents, includedActiveUsers: definition.includedActiveUsers,
      monthlyAdditionalActiveUserPriceCents: definition.monthlyAdditionalActiveUserPriceCents, activeUsers,
      monthlyTotalPriceCents: hostedMonthlyPriceCents(plan, activeUsers),
    }, `checkout:${plan}`, urls, key, provider);
  }

  /** Packs for an organization whose plan is gifted: a gift has no
   * subscription to carry them, so the first ones start a subscription of
   * packs alone, and later ones change it like a paid plan's. A Free
   * organization chooses a plan instead. */
  async checkoutPacks(organizationId: string, order: { storagePacks?: unknown; computePacks?: unknown; seats?: unknown },
    urls: { success: string; cancel: string }, key: string): Promise<SubscriptionCheckoutResult> {
    const provider = await this.requireHosted(); this.requireKey(key);
    const count = (kind: string, packs: unknown = 0): number => {
      if (typeof packs !== 'number' || !Number.isSafeInteger(packs) || packs < 0 || packs > 1000)
        throw new Error(`${kind} packs must be a whole number from 0 to 1000`);
      return packs;
    };
    const storagePacks = count('storage', order.storagePacks), computePacks = count('compute', order.computePacks);
    if (order.seats !== undefined && (typeof order.seats !== 'number' || !Number.isSafeInteger(order.seats) || order.seats < 0 || order.seats > MAX_SEATS))
      throw new Error(`seats must be a whole number from 0 to ${MAX_SEATS}`);
    const seats = (order.seats as number | undefined) ?? 0;
    if (!storagePacks && !computePacks && !seats) throw new Error('choose at least one pack or seat');
    const catalog = await provider.catalog();
    if (storagePacks && !catalog?.storagePackPriceId) throw new Error('storage packs are not available yet');
    if (computePacks && !catalog?.computePackPriceId) throw new Error('compute packs are not available yet');
    await this.assertNoSubscription(organizationId, provider, 'add packs to the existing subscription');
    const gift = await this.currentGift(organizationId);
    if (!gift) throw new Error('packs need a plan: choose Individual or Team first');
    if (seats && gift.plan !== 'team') throw new Error('seats are part of Team: upgrade to Team first');
    const activeUsers = (await this.store.listOrganizationMemberships(organizationId)).length;
    const seatPrice = HOSTED_PLANS.team.monthlyAdditionalActiveUserPriceCents;
    return this.startCheckout(organizationId, { seats, storagePacks, computePacks }, {
      planId: null, planName: null, currency: 'usd', billingInterval: 'month',
      monthlyBasePriceCents: 0, includedActiveUsers: 0, monthlyAdditionalActiveUserPriceCents: seats ? seatPrice : 0, activeUsers,
      storagePacks, computePacks, ...(seats ? { seats } : {}),
      monthlyTotalPriceCents: hostedMonthlyPriceCents('free', activeUsers, storagePacks, computePacks) + seats * seatPrice,
    }, `checkout:packs:${storagePacks}:${computePacks}${seats ? `:${seats}` : ''}`, urls, key, provider);
  }

  private async assertNoSubscription(organizationId: string, provider: SubscriptionProvider, existing: string): Promise<void> {
    const current = (await this.account(organizationId));
    if (current && current.provider !== provider.name)
      throw new Error('this organization has a billing account with another provider; reconcile it before switching');
    if (current?.subscriptionId && !['none', 'canceled', 'incomplete_expired'].includes(current.status)) throw new Error(existing);
    if (!(await this.store.getOrganization(organizationId))) throw new Error('organization not found');
  }

  private async startCheckout(organizationId: string,
    order: { plan?: PaidHostedPlanId; seats: number; storagePacks?: number; computePacks?: number },
    commercialTerms: SubscriptionCommercialTerms, operation: string, urls: { success: string; cancel: string }, key: string,
    provider: SubscriptionProvider): Promise<SubscriptionCheckoutResult> {
    const checkoutResult = { organizationId, plan: order.plan ?? null, commercialTerms,
      checkoutRequestReference: key, checkoutProvider: provider.name };
    const intent: BillingRequestIntent = { kind: 'checkout', ...order, successUrl: urls.success, checkoutResult };
    return this.idempotent(organizationId, operation, key, async (reference) => {
      const latest = await this.account(organizationId);
      if (latest && (latest.provider !== provider.name || latest.subscriptionId && !['none', 'canceled', 'incomplete_expired'].includes(latest.status)))
        throw new BillingRequestRejected('billing state changed; refresh before starting checkout');
      const customerId = await this.ensureCustomer(organizationId, `${key}:customer`, provider);
      const input = { organizationId, customerId, ...order,
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
    // A Team keeps the seats it bills; Individual has one.
    const seats = Math.max(HOSTED_PLANS[plan].includedActiveUsers,
      (await this.store.listOrganizationMemberships(organizationId)).length,
      plan === 'team' && account.plan === 'team' ? account.seats : 0);
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

  /** Keeps a subscription whose cancellation is scheduled for the end of
   * its period: its plan (or what it carries beside a gift) goes on. */
  async resume(organizationId: string, key: string) {
    this.requireKey(key);
    const account = await this.account(organizationId);
    const provider = await this.requireHosted(account?.provider);
    if (!account?.subscriptionId || !['active', 'trialing', 'past_due'].includes(account.status) || !account.cancelAtPeriodEnd)
      throw new Error('there is no ending subscription to keep');
    if (!provider.resumeSubscription) throw new Error(`${provider.name} cannot keep an ending subscription; resubscribe instead`);
    return this.idempotent(organizationId, 'resume', key, () => provider.resumeSubscription!({
      subscriptionId: account.subscriptionId!, idempotencyKey: `${key}:resume`,
    }), provider, { kind: 'resume', subscriptionId: account.subscriptionId });
  }

  /** Sets how many people a Team covers (wiki ops/billing-paddle § Seats):
   * a paid Team's subscription bills every seat past the one it includes; a
   * gifted Team's owner buys seats past the gifted ones beside the gift (the
   * first at checkout, checkoutPacks). Never fewer than the people there.
   * Like packs, seats are granted only from the verified state that follows. */
  async seats(organizationId: string, seats: unknown, key: string) {
    this.requireKey(key);
    if (typeof seats !== 'number' || !Number.isSafeInteger(seats) || seats < 1 || seats > MAX_SEATS)
      throw new Error(`seats must be a whole number from 1 to ${MAX_SEATS}`);
    const organization = await this.store.getOrganization(organizationId);
    if (!organization) throw new Error('organization not found');
    if (organization.plan !== 'team') throw new Error('seats are part of Team: upgrade to Team first');
    const members = (await this.store.listOrganizationMemberships(organizationId)).length;
    if (seats < members) throw new Error(`${members} people are in this organization: remove members first to go below ${members} seats`);
    const account = await this.account(organizationId);
    const gift = await this.currentGift(organizationId);
    const state = this.seatState('team', members, account, gift)!;
    if (state.total == null) throw new Error('this Team has no seats to change');
    if (seats < state.included) throw new Error(`${state.included} seats come with this Team: there are only paid seats to remove`);
    const extra = seats - state.included;
    if (!account?.subscriptionId || !['active', 'trialing', 'past_due'].includes(account.status))
      throw new Error(gift?.plan === 'team' ? 'buy the first seats at checkout' : 'there is no subscription to bill seats on');
    if (account.plan === 'individual') throw new Error('change the subscription to Team to add seats');
    if (extra > billedExtraSeats(account) && account.status === 'past_due')
      throw new Error('update the payment method before adding seats');
    const provider = await this.requireHosted(account.provider);
    if (account.plan === 'team') {
      const billed = HOSTED_PLANS.team.includedActiveUsers + extra;
      return this.idempotent(organizationId, `seats:${seats}`, key, () => provider.updateSeats({ subscriptionId: account.subscriptionId!,
        seatItemId: account.items.teamSeat, seats: billed, idempotencyKey: `${key}:seats` }), provider,
      { kind: 'seats', subscriptionId: account.subscriptionId, plan: 'team', seats: billed });
    }
    if (!provider.updateAddOnSeats) throw new Error(`${provider.name} cannot bill seats beside a gifted Team`);
    return this.idempotent(organizationId, `seats:${seats}`, key, () => provider.updateAddOnSeats!({ subscriptionId: account.subscriptionId!,
      extraSeats: extra, idempotencyKey: `${key}:seats` }), provider, { kind: 'seats', subscriptionId: account.subscriptionId, seats: extra });
  }

  /** Sets the total storage packs billed on the subscription: a paid plan's,
   * or one of packs alone (checkoutPacks). Like seats, the packs are granted
   * only from the verified state that follows. */
  async storagePacks(organizationId: string, packs: unknown, key: string) {
    this.requireKey(key);
    if (typeof packs !== 'number' || !Number.isSafeInteger(packs) || packs < 0)
      throw new Error('storage packs must be a whole number of 0 or more');
    const account = await this.account(organizationId);
    const provider = await this.requireHosted(account?.provider);
    if (!account?.subscriptionId || !['active', 'trialing', 'past_due'].includes(account.status))
      throw new Error(await this.currentGift(organizationId) ? 'buy the first storage packs at checkout' : 'storage packs need a paid plan');
    if (!(await provider.catalog())?.storagePackPriceId) throw new Error('storage packs are not available yet');
    if (packs > account.storagePacks && account.status === 'past_due')
      throw new Error('update the payment method before adding storage packs');
    if (packs < account.storagePacks) await this.assertStorageFits(organizationId, packs);
    return this.idempotent(organizationId, `storage:${packs}`, key, () => provider.updateStoragePacks({
      subscriptionId: account.subscriptionId!, storagePacks: packs, idempotencyKey: `${key}:storage`,
    }), provider, { kind: 'storage', subscriptionId: account.subscriptionId, storagePacks: packs });
  }

  /** Sets the total compute packs billed on the subscription, granted only
   * from the verified state that follows. Removing packs needs no check: the
   * month's compute already used stays used, and new managed computers wait
   * once the smaller allowance is spent. */
  async computePacks(organizationId: string, packs: unknown, key: string) {
    this.requireKey(key);
    if (typeof packs !== 'number' || !Number.isSafeInteger(packs) || packs < 0 || packs > 1000)
      throw new Error('compute packs must be a whole number from 0 to 1000');
    const account = await this.account(organizationId);
    const provider = await this.requireHosted(account?.provider);
    if (!account?.subscriptionId || !['active', 'trialing', 'past_due'].includes(account.status))
      throw new Error(await this.currentGift(organizationId) ? 'buy the first compute packs at checkout' : 'compute packs need a paid plan');
    if (!(await provider.catalog())?.computePackPriceId) throw new Error('compute packs are not available yet');
    if (packs > account.computePacks && account.status === 'past_due')
      throw new Error('update the payment method before adding compute packs');
    return this.idempotent(organizationId, `compute:${packs}`, key, () => provider.updateComputePacks({
      subscriptionId: account.subscriptionId!, computePacks: packs, idempotencyKey: `${key}:compute`,
    }), provider, { kind: 'compute', subscriptionId: account.subscriptionId, computePacks: packs });
  }

  /** The subscription an automatic compute top-up would charge, or why there
   * is none: it needs an active paid subscription (a plan's or packs') with a saved payment method
   * (not past due) and a provider that charges one-time top-ups. */
  async computeTopUpTarget(organizationId: string): Promise<{ subscriptionId: string; provider: SubscriptionProvider } | { reason: string }> {
    if (!this.hosted) return { reason: 'self-hosted installations have no compute billing' };
    const account = await this.account(organizationId);
    if (!account?.subscriptionId || !['active', 'trialing'].includes(account.status))
      return { reason: account?.status === 'past_due' ? 'the subscription is past due' : 'auto top-up needs an active paid subscription' };
    const provider = await this.provider(account.provider);
    if (!provider.chargeComputeTopUp || !provider.findComputeTopUp || !(await provider.configured())
      || !(await provider.catalog())?.computePackProductId) return { reason: 'compute top-ups are not available yet' };
    return { subscriptionId: account.subscriptionId, provider };
  }

  /** Removing packs must not leave the organization's managed storage over quota. */
  private async assertStorageFits(organizationId: string, packs: number): Promise<void> {
    const location = await this.store.getStorageLocation(managedStorageLocationId(organizationId));
    const organization = await this.store.getOrganization(organizationId);
    if (!location || !organization) return;
    const users = (await this.store.listOrganizationMemberships(organizationId)).length;
    const gifted = (await this.store.storagePackGift(organizationId))?.packs ?? 0;
    const quota = hostedStorageQuotaBytes(organization.plan, users, packs, gifted);
    if (quota >= hostedStorageQuotaBytes(organization.plan, users, organization.storagePacks ?? 0, gifted)) return;
    const { retainedBytes } = await this.store.storageLocationUsage(location.id);
    if (retainedBytes > quota) throw new Error(`Free ${gigabytes(retainedBytes - quota, Math.ceil)} of stored data first: `
      + `${gigabytes(retainedBytes)} is stored and the quota would be ${gigabytes(quota)}.`);
  }

  /** Bills a paid Team a seat for each person who joined without one. It
   * never removes seats: one someone left stays the owner's to remove (or
   * give to the next person), so a seat bought ahead of an invitation is not
   * taken back by the next sweep. */
  async syncSeats(organizationId: string): Promise<void> {
    if (!this.hosted) return;
    const account = (await this.account(organizationId));
    if (!account?.subscriptionId || account.plan !== 'team' || !['active', 'trialing', 'past_due'].includes(account.status)) return;
    const members = (await this.store.listOrganizationMemberships(organizationId)).length;
    const state = this.seatState('team', members, account, await this.currentGift(organizationId));
    if (!state?.autoBill || state.total == null || state.total >= members) return;
    const seats = HOSTED_PLANS.team.includedActiveUsers + Math.max(billedExtraSeats(account), members - state.included);
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
    if ('absent' in result) {
      // Proven to have had no effect. A request cannot apply long after it was
      // sent, so once that window has passed the reservation is released and
      // the person can simply try again; nothing is ever re-sent for them (GH-5).
      if (Date.now() - Number(lock.createdAt) < ABSENT_WRITE_SETTLE_MS) return { reconciled: false, pending: true };
      return this.store.transaction(async () => {
        const current = await this.store.db.prepare('SELECT requestKey FROM subscription_billing_locks WHERE organizationId=?').get(organizationId) as any;
        if (current?.requestKey !== lock.requestKey) return { reconciled: true, pending: false, applied: false };
        await this.store.db.prepare('DELETE FROM subscription_billing_requests WHERE requestKey=? AND organizationId=? AND responseJson IS NULL')
          .run(lock.requestKey, organizationId);
        await this.store.db.prepare('DELETE FROM subscription_billing_locks WHERE organizationId=? AND requestKey=?').run(organizationId, lock.requestKey);
        return { reconciled: true, pending: false, applied: false };
      });
    }
    return this.store.transaction(async () => {
      const current = await this.store.db.prepare('SELECT requestKey FROM subscription_billing_locks WHERE organizationId=?').get(organizationId) as any;
      if (current?.requestKey !== lock.requestKey) return { reconciled: true, pending: false, applied: true };
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
      return { reconciled: true, pending: false, applied: true };
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
    // One organization's events apply one at a time, each to its latest account.
    await this.store.lock(`org:${account.organizationId}`);
    account = (await this.account(account.organizationId)) ?? account;
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
          seats: HOSTED_PLANS[account.plan].includedActiveUsers, storagePacks: 0, computePacks: 0, cancelAtPeriodEnd: false };
        if (!shouldApplyBillingTransition(account, eventAt, rank, next)) return;
        const updated = (await this.patchAccount(account.organizationId, { subscriptionId, status: 'canceled',
          seats: HOSTED_PLANS[account.plan].includedActiveUsers, storagePacks: 0, computePacks: 0,
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
        { status, plan: mapped.plan, seats: mapped.seats, storagePacks: mapped.storagePacks, computePacks: mapped.computePacks,
          cancelAtPeriodEnd })) return;
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
        { status: 'past_due', plan: account.plan, seats: account.seats, storagePacks: account.storagePacks,
          computePacks: account.computePacks, cancelAtPeriodEnd: account.cancelAtPeriodEnd })) return;
      const updated = (await this.patchAccount(account.organizationId, { status: 'past_due',
        pastDueAt: account.pastDueAt ?? Date.now(), lastError: 'The latest subscription payment failed.',
        lastEventAt: eventAt, lastEventRank: rank, verifiedAt: Date.now() }));
      (await this.reconcileAccount(updated));
    } else if (event.type === 'invoice.paid'
      && ['active', 'trialing', 'past_due', 'unpaid'].includes(account.status)) {
      const rank = billingEventRank(event.type, 'active');
      if (!shouldApplyBillingTransition(account, eventAt, rank,
        { status: 'active', plan: account.plan, seats: account.seats, storagePacks: account.storagePacks,
          computePacks: account.computePacks, cancelAtPeriodEnd: account.cancelAtPeriodEnd })) return;
      const updated = (await this.patchAccount(account.organizationId, { status: 'active', pastDueAt: undefined,
        lastError: undefined, lastEventAt: eventAt, lastEventRank: rank, verifiedAt: Date.now() }));
      (await this.reconcileAccount(updated));
    }
  }

  /** Whether the verified subscription is paid for now: active, trialing, or
   * past due within its grace. */
  private paidFor(account: BillingAccount, now: number): boolean {
    if (!account.verifiedAt) return false;
    if (account.status === 'active' || account.status === 'trialing') return true;
    return account.status === 'past_due' && Boolean(account.pastDueAt) && now < account.pastDueAt! + this.pastDueGraceMs;
  }

  private async reconcileAccount(account: BillingAccount, now = Date.now()): Promise<void> {
    await this.reconcileOrganization(account.organizationId, now);
  }

  private async reconcileOrganization(organizationId: string, now = Date.now()): Promise<void> {
    await this.store.transaction(async () => {
      // The plan follows the gift and account as they are under the lock, not
      // as the caller read them.
      await this.store.lock(`org:${organizationId}`);
      const account = await this.account(organizationId);
      const gift = await this.currentGift(organizationId);
      const paid = account ? this.paidFor(account, now) : false;
      const paidPlan = paid ? account!.plan : 'free';
      const plan = paidPlan === 'team' || gift?.plan === 'team' ? 'team'
        : paidPlan === 'individual' || gift?.plan === 'individual' ? 'individual' : 'free';
      // Paid packs count while their subscription is paid for, whatever the
      // plan: a gift never grants them, nor does removing it take them away.
      const storagePacks = paid ? account!.storagePacks : 0;
      const computePacks = paid ? account!.computePacks : 0;
      const organization = await this.store.getOrganization(organizationId);
      if (organization?.plan !== plan) await this.store.setOrganizationPlan(organizationId, plan);
      if ((organization?.storagePacks ?? 0) !== storagePacks)
        await this.store.setOrganizationStoragePacks(organizationId, storagePacks);
      if ((organization?.computePacks ?? 0) !== computePacks)
        await this.store.setOrganizationComputePacks(organizationId, computePacks);
      const members = (await this.store.listOrganizationMemberships(organizationId)).length;
      const seatLimit = this.seatState(plan, members, account, gift, now)?.limit ?? null;
      if ((organization?.seatLimit ?? null) !== seatLimit) await this.store.setOrganizationSeatLimit(organizationId, seatLimit);
    });
  }

  private async mapSubscription(object: any, provider: SubscriptionProvider): Promise<{ plan: HostedPlanId; seats: number;
    storagePacks: number; computePacks: number; items: Record<string, string> }> {
    const currentCatalog = await provider.catalog();
    if (!currentCatalog) throw new Error('subscription catalog is not configured');
    const catalogs = await rememberSubscriptionCatalog(this.store, provider.name, currentCatalog);
    const items: Record<string, string> = {};
    let plan: HostedPlanId | undefined;
    let seats = HOSTED_PLANS.team.includedActiveUsers;
    let storagePacks = 0;
    let computePacks = 0;
    for (const item of object.items?.data ?? []) {
      const price = stringId(item.price);
      const product = stringId(item.price?.product);
      const catalog = catalogs.find((entry) => [entry.individualPriceId, entry.teamBasePriceId, entry.teamSeatPriceId,
        entry.storagePackPriceId, entry.computePackPriceId].includes(price ?? '')) ?? currentCatalog;
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
      } else if (catalog.storagePackPriceId && price === catalog.storagePackPriceId) {
        if (items.storagePack) throw new Error('subscription contains duplicate storage pack prices');
        if (catalog.storagePackProductId && product !== catalog.storagePackProductId)
          throw new Error('Storage pack price belongs to an unexpected product');
        const quantity = Number(item.quantity);
        if (!Number.isSafeInteger(quantity) || quantity < 0) throw new Error('storage pack quantity is invalid');
        storagePacks = quantity; items.storagePack = String(item.id);
      } else if (catalog.computePackPriceId && price === catalog.computePackPriceId) {
        if (items.computePack) throw new Error('subscription contains duplicate compute pack prices');
        if (catalog.computePackProductId && product !== catalog.computePackProductId)
          throw new Error('Compute pack price belongs to an unexpected product');
        const quantity = Number(item.quantity);
        if (!Number.isSafeInteger(quantity) || quantity < 0) throw new Error('compute pack quantity is invalid');
        computePacks = quantity; items.computePack = String(item.id);
      } else if (provider.customerMode === 'checkout') throw new Error('Paddle subscription contains an unexpected price');
    }
    // Packs and seats alone ride beside a gifted plan (checkoutPacks); they
    // bill no plan. Their `seats` are the seats bought, none included.
    if (!plan && (items.teamSeat || storagePacks || computePacks)) plan = 'free';
    if (!plan) throw new Error(`subscription contains no configured ${BRAND} plan price`);
    if (provider.customerMode === 'checkout' && plan === 'individual' && items.teamSeat)
      throw new Error('Individual subscription contains Team seats');
    return { plan, seats: plan === 'team' ? seats : plan === 'free' && items.teamSeat ? seats - HOSTED_PLANS.team.includedActiveUsers
      : HOSTED_PLANS.individual.includedActiveUsers, storagePacks, computePacks, items };
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
    (await this.store.db.prepare(`UPDATE subscription_billing_accounts SET subscriptionId=?, plan=?, status=?, seats=?, storagePacks=?,
      computePacks=?, itemsJson=?, currentPeriodEnd=?, cancelAtPeriodEnd=?, lastEventAt=?, lastEventRank=?, verifiedAt=?, pastDueAt=?, lastError=?, updatedAt=?
      WHERE organizationId=?`).run(patch.subscriptionId ?? current.subscriptionId ?? null,
      patch.plan ?? current.plan, patch.status ?? current.status, patch.seats ?? current.seats,
      patch.storagePacks ?? current.storagePacks, patch.computePacks ?? current.computePacks, JSON.stringify(patch.items ?? current.items), patch.currentPeriodEnd ?? current.currentPeriodEnd ?? null,
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
    // One billing request reserves the organization at a time.
    await this.store.lock(`org:${organizationId}`);
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
    storagePackPriceId: 'price_storage_pack', computePackPriceId: 'price_compute_pack',
  }) {}
  configured() { return true; }
  catalog() { return this.config; }
  async createCustomer(input: any) { this.calls.push({ method: 'createCustomer', input }); return { id: `cus_${input.organizationId}` }; }
  async createCheckout(input: any) { this.calls.push({ method: 'createCheckout', input }); return { id: 'cs_test', url: 'https://checkout.test/session' }; }
  async createPortal(input: any) { this.calls.push({ method: 'createPortal', input }); return { url: 'https://portal.test/session' }; }
  async changePlan(input: any) { this.calls.push({ method: 'changePlan', input }); return { id: input.subscriptionId }; }
  async cancelAtPeriodEnd(input: any) { this.calls.push({ method: 'cancelAtPeriodEnd', input }); return { id: input.subscriptionId }; }
  async updateSeats(input: any) { this.calls.push({ method: 'updateSeats', input }); return { id: input.subscriptionId }; }
  async updateStoragePacks(input: any) { this.calls.push({ method: 'updateStoragePacks', input }); return { id: input.subscriptionId }; }
  async updateComputePacks(input: any) { this.calls.push({ method: 'updateComputePacks', input }); return { id: input.subscriptionId }; }
  async updateAddOnSeats(input: any) { this.calls.push({ method: 'updateAddOnSeats', input }); return { id: input.subscriptionId }; }
  async resumeSubscription(input: any) { this.calls.push({ method: 'resumeSubscription', input }); return { id: input.subscriptionId }; }
  verifyWebhook(raw: Buffer): BillingEvent { return JSON.parse(raw.toString('utf8')); }
}

/** The most seats one Team may set at once. */
const MAX_SEATS = 10_000;

/** How many people a Team covers and how they are paid for (seatState). */
export interface TeamSeats {
  /** People covered: the included or gifted seats plus those bought; null
   * on a Team the operator set directly, which counts no seats. */
  total: number | null;
  used: number;
  gifted: number;
  /** Seats bought at the seat price. */
  paid: number;
  /** Seats that cost nothing: the plan's one, or the gifted ones. */
  included: number;
  /** How many people may be members; null when the next one is billed a seat. */
  limit: number | null;
  autoBill: boolean;
  priceCents: number;
}

/** Seats a subscription bills at the seat price: a Team's past the one it
 * includes, or those alone beside a gifted Team. */
function billedExtraSeats(account: BillingAccount): number {
  if (account.plan === 'team') return Math.max(0, account.seats - HOSTED_PLANS.team.includedActiveUsers);
  return account.plan === 'free' && account.items.teamSeat ? Math.max(0, account.seats) : 0;
}

/** What a subscription bills each month: its plan and seats, packs and any seats beside a gift. */
function billedMonthlyCents(account: BillingAccount): number {
  const besideGift = account.plan === 'free' ? billedExtraSeats(account) * HOSTED_PLANS.team.monthlyAdditionalActiveUserPriceCents : 0;
  return hostedMonthlyPriceCents(account.plan, account.seats, account.storagePacks, account.computePacks) + besideGift;
}

function rowAccount(row: any): BillingAccount | undefined {
  if (!row) return undefined;
  if (!isHostedPlanId(row.plan)) throw new Error(`billing account contains unknown plan ${String(row.plan)}`);
  return { organizationId: row.organizationId, provider: row.provider, customerId: row.customerId ?? undefined,
    subscriptionId: row.subscriptionId ?? undefined, plan: row.plan, status: normalizeStatus(row.status), seats: Number(row.seats),
    storagePacks: Number(row.storagePacks ?? 0) || 0,
    computePacks: Number(row.computePacks ?? 0) || 0,
    items: JSON.parse(row.itemsJson || '{}'), currentPeriodEnd: row.currentPeriodEnd ?? undefined,
    cancelAtPeriodEnd: Boolean(row.cancelAtPeriodEnd), lastEventAt: Number(row.lastEventAt),
    lastEventRank: Number(row.lastEventRank || 0),
    verifiedAt: row.verifiedAt ?? undefined, pastDueAt: row.pastDueAt ?? undefined,
    lastError: row.lastError ?? undefined };
}
/** Bytes as the console shows them (binary GB), to a tenth. */
function gigabytes(bytes: number, round: (value: number) => number = Math.round): string {
  return `${round(bytes / 1024 ** 3 * 10) / 10} GB`;
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
 * the larger billed seat quantity, then fewer storage packs, then fewer
 * compute packs. A strictly newer
 * event always wins. */
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
  next: Pick<BillingAccount, 'status' | 'plan' | 'seats' | 'storagePacks' | 'computePacks' | 'cancelAtPeriodEnd'>): boolean {
  if (eventAt > current.lastEventAt) return true;
  if (eventAt < current.lastEventAt) return false;
  if (eventRank !== current.lastEventRank) return eventRank > current.lastEventRank;
  const planRestriction = (plan: HostedPlanId) => plan === 'free' ? 3 : plan === 'individual' ? 2 : 1;
  const before = [planRestriction(current.plan), current.cancelAtPeriodEnd ? 1 : 0, current.seats, -current.storagePacks, -current.computePacks];
  const after = [planRestriction(next.plan), next.cancelAtPeriodEnd ? 1 : 0, next.seats, -next.storagePacks, -next.computePacks];
  for (let index = 0; index < before.length; index++) {
    if (after[index] !== before[index]) return after[index]! > before[index]!;
  }
  return false;
}
