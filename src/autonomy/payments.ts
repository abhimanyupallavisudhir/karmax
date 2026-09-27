import { getDomain } from 'tldts';
import { allows, attenuate } from '../platform/capabilities.js';
import { PermissionRequests } from '../platform/permission-requests.js';
import * as __asyncCollections from '../util/async-collections.js';
import { Store } from '../store/db.js';
import { newId } from '../util/id.js';
import crypto from 'node:crypto';
import type { CredentialBroker } from './broker.js';

/**
 * Payments (SPEC §7.6). Cards are project/global RESOURCES; an agent never owns a
 * wallet. *Which* cards an agent may use is a capability (`use-card:<id>`); *how
 * much* it may spend is the budget lease (a number). Money lives in a shared
 * funding source + policy limits, not a per-card wallet.
 *
 * The rail is a pluggable PaymentProvider (mock now; Stripe Issuing / AP2 later)
 * behind this interface, so it can be swapped — and the implementation can live
 * in an editable layer so agents can repair it when a provider's API changes.
 */
export interface Card {
  id: string;
  provider: string;
  scope: 'project' | 'organization' | 'global';
  scopeId?: string; // projectId for project scope; organizationId for organization scope; undefined for legacy global
  label: string;
  cap: number; // hard ceiling enforced at authorization (cents)
  available: number; // funds available to spend (cents)
  merchantLock?: string[]; // allowed merchants (empty/undefined = any)
  externalId?: string;
  currency?: string;
  status?: string;
  cardholderId?: string;
  last4?: string;
  createdAt: number;
}

export interface CardSpec {
  scope: 'project' | 'organization' | 'global';
  scopeId?: string;
  label: string;
  cap: number;
  merchantLock?: string[];
  organizationId?: string;
  currency?: string;
  cardholderId?: string;
  /** Required by rails that register a card the human already holds (vault-card). */
  details?: CardDetails;
}

/** The secret half of a card. Never stored in the metadata index, never returned
 * to an agent — resolved out of the vault only to be typed into a checkout. */
export interface CardDetails {
  number: string;
  cvc: string;
  expMonth: number;
  expYear: number;
  /** Billing address. Optional, but many checkouts decline on AVS without it. */
  billing?: CardBillingAddress;
}

export interface CardBillingAddress {
  line1?: string;
  city?: string;
  postalCode?: string;
  country?: string;
}

/** Vault handle holding a registered card's secret half. */
export const cardSecretHandle = (cardId: string) => `payment:card:${cardId}`;

/**
 * What can still be spent on a card. `available` alone is not the answer: on an
 * issuing rail it is the *organization's* whole balance, shared by every card
 * that rail issued, so a card capped at $123 would otherwise report the org's
 * $250 as its remaining limit. A rail with no ceiling of its own (the human's
 * own virtual card, where only the issuer can decline) has nothing but funds —
 * and there `cap - spent` would double-count what `available` already reflects.
 */
export function cardRemaining(card: Pick<Card, 'cap' | 'available' | 'status'>, spent: number,
  enforcesCardCap = true): number {
  if (card.status === 'canceled') return 0;
  return Math.max(0, enforcesCardCap ? Math.min(card.available, card.cap - spent) : card.available);
}

export interface PaymentBalance {
  available: number;
  currency: string;
  fundingUrl?: string;
}

export interface PaymentCardholderInput {
  type: 'individual' | 'company';
  name: string;
  email?: string;
  phone?: string;
  address: { line1: string; line2?: string; city: string; state?: string; postalCode: string; country: string };
  firstName?: string;
  lastName?: string;
  dob?: { day: number; month: number; year: number };
}

export interface AuthorizeResult {
  ok: boolean;
  reason?: string;
  transactionId?: string;
}

/** How a user connects funding to a provider (SPEC §7.6). */
export interface ProviderInfo {
  name: string;
  label: string;
  /** 'local' = no external account (mock); 'card' = register a card you already
   *  hold; 'oauth' = connect a provider account that issues cards for you. */
  kind: 'local' | 'card' | 'oauth';
  /** Whether this deployment has a complete, usable connection flow. */
  available: boolean;
  connected: boolean;
  connectionStatus?: string;
  help?: string;
}
export interface PaymentConnectionContext {
  /** The tenant that owns the funding connection. */
  organizationId: string;
  userId?: string;
  redirectUri?: string;
}
export interface ConnectResult {
  status: 'connected' | 'awaiting_oauth' | 'unavailable';
  /** OAuth URL for the user to complete (kind 'oauth'). karmax never sees card data. */
  url?: string;
  detail?: string;
}

export interface PaymentProvider {
  readonly name: string;
  /** Immediate providers settle at request time; webhook providers reserve first. */
  readonly authorizationMode: 'immediate' | 'webhook';
  /** Whether `cap` is a ceiling the rail enforces independently of funds (default
   * true). A rail that only mirrors a limit the human set at their own issuer has
   * no second ceiling: spending past the declared figure means "top up", not
   * "denied". Enforcement there is the issuer's decline, never this number. */
  readonly enforcesCardCap?: boolean;
  provisionCard(spec: CardSpec): Promise<Card>;
  getCard(cardId: string): Promise<Card | undefined>;
  fund(cardId: string, amount: number): Promise<void>;
  /** Attempt a charge; the rail enforces the hard cap + merchant lock + funds. */
  authorize(cardId: string, amount: number, merchant?: string): Promise<AuthorizeResult>;
  /** Provider metadata for the connect surface. */
  describe(ctx?: PaymentConnectionContext): ProviderInfo | Promise<ProviderInfo>;
  /** Start (or report) connecting funding to this provider. */
  connect(ctx?: PaymentConnectionContext): Promise<ConnectResult>;
  balance(organizationId: string): Promise<PaymentBalance>;
  revoke(cardId: string): Promise<void>;
  /** Resolve the secret half so it can be typed into a checkout. Only rails that
   * move real money implement this; its presence is what makes a card fillable. */
  retrieveCardDetails?(cardId: string): Promise<CardDetails>;
  /** Issuing-only: rails that mint cards against a compliance record. A rail that
   * registers a card the human already holds has no cardholder surface. */
  listCardholders?(organizationId: string): Promise<any[]>;
  createCardholder?(organizationId: string, input: PaymentCardholderInput): Promise<any>;
}

/** Mock rail: card state lives in the karmax store. Real rails (Stripe) keep it provider-side. */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';
  readonly authorizationMode = 'immediate';
  constructor(private store: Store) {}

  async provisionCard(spec: { scope: 'project' | 'organization' | 'global'; scopeId?: string; label: string; cap: number; merchantLock?: string[] }): Promise<Card> {
    if (!Number.isSafeInteger(spec.cap) || spec.cap <= 0) throw new Error('card cap must be a positive number of cents');
    const card: Card = {
      id: newId('card'),
      provider: this.name,
      scope: spec.scope,
      scopeId: spec.scopeId,
      label: spec.label,
      cap: spec.cap,
      available: 0,
      merchantLock: spec.merchantLock,
      createdAt: Date.now(),
    };
    (await this.store.createCard(card));
    return card;
  }
  async getCard(cardId: string): Promise<Card | undefined> {
    return (await this.store.getCard(cardId));
  }
  async fund(cardId: string, amount: number): Promise<void> {
    return this.store.transaction(async () => {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('funding amount must be a positive number of cents');
    const c = (await this.store.getCard(cardId));
    if (!c) throw new Error('no such card');
    (await this.store.updateCard(cardId, { available: c.available + amount }));

    });
  }
  async authorize(cardId: string, amount: number, merchant?: string): Promise<AuthorizeResult> {
    return this.store.transaction(async () => {
    const c = (await this.store.getCard(cardId));
    if (!c) return { ok: false, reason: 'no such card' };
    if (!Number.isSafeInteger(amount) || amount <= 0) return { ok: false, reason: 'amount must be a positive number of cents' };
    if (c.merchantLock?.length && (!merchant || !c.merchantLock.includes(merchant))) return { ok: false, reason: 'merchant not allowed' };
    if ((await this.store.cardPaymentSpent(cardId, true)) + amount > c.cap) return { ok: false, reason: 'exceeds card cap' };
    if (amount > c.available) return { ok: false, reason: 'insufficient funds' };
    (await this.store.updateCard(cardId, { available: c.available - amount }));
    return { ok: true, transactionId: newId('txn') };

    });
  }
  describe(): ProviderInfo {
    return { name: this.name, label: 'Local test funds', kind: 'local', available: true, connected: true,
      help: 'Simulated funds for testing payment policy. No real money moves.' };
  }
  async connect(): Promise<ConnectResult> {
    return { status: 'connected', detail: 'Local provider needs no connection — add and fund cards below.' };
  }
  async balance(organizationId: string): Promise<PaymentBalance> {
    return { available: (await this.store.listOrganizationCards(organizationId))
      .filter((card) => card.provider === this.name).reduce((sum, card) => sum + card.available, 0), currency: 'usd' };
  }
  async revoke(cardId: string): Promise<void> {
    return this.store.transaction(async () => {
    if (!(await this.store.getCard(cardId))) throw new Error('no such card');
    (await this.store.updateCard(cardId, { status: 'canceled', available: 0 }));

    });
  }
}

/**
 * The universal rail (SPEC §7.6): a virtual card the human already holds — from
 * their own bank, Revolut, Wise, a prepaid card — whose spending limit they set
 * with their own issuer.
 *
 * This is the rail that works in every country with no signup, because karmax
 * does not issue, fund, or authorize anything: the issuer declines when the
 * limit is reached, and "top up" means raising that limit. Karmax stores the
 * secret half in the vault and types it into checkout through the origin-checked
 * secure fill; the PAN never enters an agent's context.
 *
 * The trade against an issuing rail is honest and one-sided: karmax cannot read
 * the real balance, so `cap`/`available` here are the human's *declared* figure.
 * They drive fast failure and bookkeeping, not enforcement — a decline at the
 * issuer is the only authoritative answer.
 */
export class VaultCardProvider implements PaymentProvider {
  readonly name = 'vault-card';
  readonly authorizationMode = 'immediate';
  readonly enforcesCardCap = false;
  constructor(private store: Store, private broker: CredentialBroker) {}

  private validate(details: CardDetails | undefined): CardDetails {
    if (!details) throw new Error('card details are required to register a card');
    const number = String(details.number ?? '').replace(/[\s-]/g, '');
    if (!/^\d{12,19}$/.test(number) || !luhnValid(number))
      throw new Error('card number must be a valid 12–19 digit card number');
    if (!/^\d{3,4}$/.test(String(details.cvc ?? ''))) throw new Error('cvc must be 3 or 4 digits');
    const expMonth = Number(details.expMonth);
    const expYear = Number(details.expYear);
    if (!Number.isInteger(expMonth) || expMonth < 1 || expMonth > 12 || !Number.isInteger(expYear))
      throw new Error('card expiry must be a real month and year');
    const now = new Date();
    if (expYear < now.getFullYear() || (expYear === now.getFullYear() && expMonth < now.getMonth() + 1))
      throw new Error('card has already expired');
    const billing = Object.fromEntries(Object.entries(details.billing ?? {})
      .map(([field, value]) => [field, String(value ?? '').trim()]).filter(([, value]) => value));
    return { number, cvc: String(details.cvc), expMonth, expYear,
      ...(Object.keys(billing).length ? { billing } : {}) };
  }

  async provisionCard(spec: CardSpec): Promise<Card> {
    if (!Number.isSafeInteger(spec.cap) || spec.cap <= 0)
      throw new Error('card limit must be a positive number of cents');
    const details = this.validate(spec.details);
    const card: Card = {
      id: newId('card'), provider: this.name, scope: spec.scope, scopeId: spec.scopeId,
      label: spec.label, cap: spec.cap, available: spec.cap, merchantLock: spec.merchantLock,
      currency: (spec.currency ?? 'usd').toLowerCase(), status: 'active',
      last4: details.number.slice(-4), createdAt: Date.now(),
    };
    (await this.broker.registerHandle(cardSecretHandle(card.id), JSON.stringify(details)));
    try { (await this.store.createCard(card)); }
    catch (error) { (await this.broker.deleteHandle(cardSecretHandle(card.id))); throw error; }
    return card;
  }
  async getCard(cardId: string): Promise<Card | undefined> {
    const card = (await this.store.getCard(cardId)) as Card | undefined;
    return card?.provider === this.name ? card : undefined;
  }
  /** "Topping up" is the human raising the limit at their own issuer; karmax
   *  only mirrors that figure so it can fail fast before a decline. */
  async fund(cardId: string, amount: number): Promise<void> {
    if (!Number.isSafeInteger(amount) || amount <= 0)
      throw new Error('top-up amount must be a positive number of cents');
    const card = await this.getCard(cardId);
    if (!card) throw new Error('no such card');
    if (card.status === 'canceled') throw new Error('card is not active');
    (await this.store.updateCard(cardId, { available: card.available + amount, cap: card.cap + amount }));
  }
  async authorize(cardId: string, amount: number, merchant?: string): Promise<AuthorizeResult> {
    const card = await this.getCard(cardId);
    if (!card) return { ok: false, reason: 'no such card' };
    if (card.status === 'canceled') return { ok: false, reason: 'card is not active' };
    if (!Number.isSafeInteger(amount) || amount <= 0) return { ok: false, reason: 'amount must be a positive number of cents' };
    if (card.merchantLock?.length && (!merchant || !card.merchantLock.includes(merchant)))
      return { ok: false, reason: 'merchant not allowed' };
    if (amount > card.available) return { ok: false, reason: 'exceeds the declared remaining limit' };
    (await this.store.updateCard(cardId, { available: card.available - amount }));
    return { ok: true, transactionId: newId('txn') };
  }
  async retrieveCardDetails(cardId: string): Promise<CardDetails> {
    const card = await this.getCard(cardId);
    if (!card || card.status === 'canceled') throw new Error('card is not active');
    const handle = cardSecretHandle(cardId);
    return JSON.parse(this.broker.resolve(handle, { caps: [`use-credential:${handle}`] })) as CardDetails;
  }
  describe(): ProviderInfo {
    return { name: this.name, label: 'Your own virtual card', kind: 'card', available: true, connected: true,
      help: 'Create a virtual card with a spending limit in your own banking app, then register it here. '
        + 'Your bank enforces the limit and declines when it runs out; raise the limit to top it up.' };
  }
  async connect(): Promise<ConnectResult> {
    return { status: 'connected', detail: 'Nothing to connect — register a card below.' };
  }
  async balance(organizationId: string): Promise<PaymentBalance> {
    return { available: (await this.store.listOrganizationCards(organizationId))
      .filter((card) => card.provider === this.name && card.status !== 'canceled')
      .reduce((sum, card) => sum + card.available, 0), currency: 'usd' };
  }
  /** Revoking must destroy the secret, not just hide the row. */
  async revoke(cardId: string): Promise<void> {
    if (!await this.getCard(cardId)) throw new Error('no such card');
    (await this.broker.deleteHandle(cardSecretHandle(cardId)));
    (await this.store.updateCard(cardId, { status: 'canceled', available: 0 }));
  }
}

/** Catches transposed/mistyped digits before a card is ever presented. */
function luhnValid(number: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = number.length - 1; i >= 0; i--) {
    let digit = number.charCodeAt(i) - 48;
    if (double) digit = digit > 4 ? digit * 2 - 9 : digit * 2;
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

const STRIPE_API_VERSION = '2025-03-31.basil';
export const STRIPE_CLIENT_ID_KEY = 'payments:stripe:client-id';
export const STRIPE_SECRET_KEY_HANDLE = 'platform:stripe:secret-key';
export const STRIPE_WEBHOOK_SECRET_HANDLE = 'platform:stripe:webhook-secret';
type FetchLike = typeof fetch;

export interface StripePlatformStatus {
  configured: boolean;
  clientId?: string;
  secretKeyConfigured: boolean;
  webhookConfigured: boolean;
  source: 'ui' | 'environment' | 'none';
}

/** Production Stripe Issuing rail. The deployment owns only the Connect
 * application credentials; every account id, balance, card, and ledger entry is
 * keyed to the organization that completed OAuth. */
export class StripeIssuingProvider implements PaymentProvider {
  readonly name = 'stripe';
  readonly authorizationMode = 'webhook';
  constructor(private store?: Store, private fetcher: FetchLike = fetch,
    private env: NodeJS.ProcessEnv = process.env, private broker?: CredentialBroker) {}

  private async configured(): Promise<boolean> {
    return Boolean(this.store && (await this.clientId()) && this.hasSecret(STRIPE_SECRET_KEY_HANDLE, 'STRIPE_SECRET_KEY'));
  }
  private async clientId(): Promise<string | undefined> {
    return (await this.store?.kvGet(STRIPE_CLIENT_ID_KEY))?.trim() || this.env.STRIPE_CLIENT_ID?.trim() || undefined;
  }
  private hasSecret(handle: string, environmentName: 'STRIPE_SECRET_KEY' | 'STRIPE_WEBHOOK_SECRET'): boolean {
    return Boolean(this.broker?.hasHandle(handle) || this.env[environmentName]);
  }
  private secret(handle: string, environmentName: 'STRIPE_SECRET_KEY' | 'STRIPE_WEBHOOK_SECRET'): string | undefined {
    if (this.broker?.hasHandle(handle))
      return this.broker.resolve(handle, { caps: [`use-credential:${handle}`] });
    return this.env[environmentName];
  }
  async platformStatus(): Promise<StripePlatformStatus> {
    const clientId = (await this.clientId());
    const uiManaged = Boolean((await this.store?.kvGet(STRIPE_CLIENT_ID_KEY))
      || this.broker?.hasHandle(STRIPE_SECRET_KEY_HANDLE)
      || this.broker?.hasHandle(STRIPE_WEBHOOK_SECRET_HANDLE));
    const secretKeyConfigured = this.hasSecret(STRIPE_SECRET_KEY_HANDLE, 'STRIPE_SECRET_KEY');
    return {
      configured: Boolean(this.store && clientId && secretKeyConfigured),
      ...(clientId ? { clientId } : {}),
      secretKeyConfigured,
      webhookConfigured: this.hasSecret(STRIPE_WEBHOOK_SECRET_HANDLE, 'STRIPE_WEBHOOK_SECRET'),
      source: uiManaged ? 'ui' : clientId || secretKeyConfigured || this.env.STRIPE_WEBHOOK_SECRET ? 'environment' : 'none',
    };
  }
  async configurePlatform(input: { clientId: string; secretKey?: string; webhookSecret?: string }): Promise<StripePlatformStatus> {
    const store = this.requireStore();
    if (!this.broker) throw new Error('Krmax encrypted secret storage is unavailable');
    const clientId = input.clientId.trim();
    const secretKey = input.secretKey?.trim();
    const webhookSecret = input.webhookSecret?.trim();
    if (!/^ca_[A-Za-z0-9_]+$/.test(clientId)) throw new Error('Stripe Connect client ID must start with ca_');
    if (secretKey && !/^sk_(?:test|live)_\S+$/.test(secretKey))
      throw new Error('Stripe secret key must be an sk_test_… or sk_live_… key');
    if (webhookSecret && !/^whsec_\S+$/.test(webhookSecret))
      throw new Error('Stripe webhook signing secret must start with whsec_');
    if (!secretKey && !this.hasSecret(STRIPE_SECRET_KEY_HANDLE, 'STRIPE_SECRET_KEY'))
      throw new Error('Stripe secret key is required');
    (await store.kvSet(STRIPE_CLIENT_ID_KEY, clientId));
    if (secretKey) (await this.broker.registerHandle(STRIPE_SECRET_KEY_HANDLE, secretKey));
    if (webhookSecret) (await this.broker.registerHandle(STRIPE_WEBHOOK_SECRET_HANDLE, webhookSecret));
    return (await this.platformStatus());
  }
  private requireStore(): Store {
    if (!this.store) throw new Error('Stripe Issuing store is unavailable');
    return this.store;
  }
  private async connection(organizationId: string): Promise<any> {
    const value = (await this.requireStore().getPaymentConnection(organizationId, this.name));
    if (!value || value.status !== 'ready') throw new Error('Stripe is not connected for this organization');
    return value;
  }
  private async organizationForCard(card: Card): Promise<string> {
    if (card.scope === 'organization') return card.scopeId!;
    if (card.scope === 'project') return (await this.requireStore().getProject(card.scopeId!))?.organizationId
      ?? (() => { throw new Error('card project no longer exists'); })();
    return 'org_personal';
  }
  private async request(method: string, path: string, accountId?: string,
    params?: Record<string, unknown>, idempotencyKey?: string): Promise<any> {
    const key = this.secret(STRIPE_SECRET_KEY_HANDLE, 'STRIPE_SECRET_KEY');
    if (!key) throw new Error('Stripe platform secret is not configured');
    const headers: Record<string, string> = {
      authorization: `Bearer ${key}`,
      'stripe-version': this.env.STRIPE_API_VERSION || STRIPE_API_VERSION,
    };
    if (accountId) headers['stripe-account'] = accountId;
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    let body: string | undefined;
    if (params) {
      const form = new URLSearchParams();
      for (const [name, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) form.set(name, String(value));
      }
      body = form.toString();
      headers['content-type'] = 'application/x-www-form-urlencoded';
    }
    const response = await this.fetcher(`https://api.stripe.com${path}`, { method, headers, ...(body ? { body } : {}) });
    const value = await response.json().catch(() => ({})) as any;
    if (!response.ok) throw new Error(value?.error?.message ?? value?.error_description ?? `Stripe API returned ${response.status}`);
    return value;
  }
  async describe(ctx?: PaymentConnectionContext): Promise<ProviderInfo> {
    const connection = ctx && (await this.store?.getPaymentConnection(ctx.organizationId, this.name));
    const available = (await this.configured());
    return {
      name: this.name,
      label: 'Stripe Issuing',
      kind: 'oauth',
      available,
      connected: Boolean(connection?.status === 'ready'),
      connectionStatus: connection?.status,
      help: connection?.status === 'ready'
        ? `Connected to ${connection.accountId}${connection.livemode ? ' (live)' : ' (test)'}. Funds come from this organization's Stripe Issuing balance.${this.hasSecret(STRIPE_WEBHOOK_SECRET_HANDLE, 'STRIPE_WEBHOOK_SECRET') ? '' : ' Add the webhook signing secret in Stripe platform setup before issuing active cards.'}`
        : connection?.status === 'attention'
          ? `Connected account ${connection.accountId} needs Stripe card_issuing capability activation before Krmax can issue cards.`
        : available
          ? 'Connect this organization’s Stripe account. The deployment Connect app identifies Krmax; it does not fund cards.'
          : 'An installation administrator must complete Stripe platform setup before organizations can connect.',
    };
  }
  async connect(ctx?: PaymentConnectionContext): Promise<ConnectResult> {
    if (!ctx || !(await this.configured()) || !ctx.redirectUri) return { status: 'unavailable',
      detail: 'Stripe Connect needs deployment client/secret configuration and a public callback URL before each organization can connect its own account.' };
    const existing = (await this.store!.getPaymentConnection(ctx.organizationId, this.name));
    if (existing?.status === 'ready') return { status: 'connected', detail: `Connected to ${existing.accountId}.` };
    const state = (await this.store!.createPaymentOAuthState({
      organizationId: ctx.organizationId, userId: ctx.userId, redirectUri: ctx.redirectUri,
    }));
    const url = new URL('https://connect.stripe.com/oauth/authorize');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'read_write');
    url.searchParams.set('client_id', (await this.clientId())!);
    url.searchParams.set('redirect_uri', ctx.redirectUri);
    url.searchParams.set('state', state);
    return { status: 'awaiting_oauth', url: url.toString(),
      detail: 'Authorize this organization’s Stripe account. Its Issuing balance remains separate from every other organization.' };
  }
  async completeOAuth(state: string, code: string, userId: string): Promise<any> {
    if (!(await this.configured())) throw new Error('Stripe Connect is not configured');
    const pending = (await this.store!.consumePaymentOAuthState(state, userId));
    if (!pending) throw new Error('Stripe connection state is invalid, expired, or already used');
    const form = new URLSearchParams({
      client_secret: this.secret(STRIPE_SECRET_KEY_HANDLE, 'STRIPE_SECRET_KEY')!,
      code,
      grant_type: 'authorization_code',
    });
    const response = await this.fetcher('https://connect.stripe.com/oauth/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString(),
    });
    const token = await response.json().catch(() => ({})) as any;
    if (!response.ok || !token.stripe_user_id)
      throw new Error(token.error_description ?? token.error ?? `Stripe OAuth returned ${response.status}`);
    const account = await this.request('GET', '/v1/account', token.stripe_user_id);
    const capability = account.capabilities?.card_issuing;
    const saved = (await this.store!.upsertPaymentConnection({
      organizationId: pending.organizationId,
      provider: this.name,
      accountId: token.stripe_user_id,
      status: capability === 'active' ? 'ready' : 'attention',
      livemode: Boolean(token.livemode),
      details: { businessName: account.business_profile?.name ?? account.settings?.dashboard?.display_name,
        country: account.country, cardIssuing: capability ?? 'unknown' },
    }));
    const settings = (await this.store!.getSettings(`organization:${pending.organizationId}`, 'payments')) ?? {};
    (await this.store!.setSettings(`organization:${pending.organizationId}`, 'payments', { ...settings, provider: this.name }));
    return saved;
  }
  async disconnect(organizationId: string): Promise<void> {
    const connection = (await this.requireStore().getPaymentConnection(organizationId, this.name));
    if (!connection) throw new Error('Stripe is not connected for this organization');
    for (const card of (await this.requireStore().listOrganizationCards(organizationId))
      .filter((candidate) => candidate.provider === this.name && candidate.status !== 'canceled')) {
      if (card.externalId) await this.request('POST',
        `/v1/issuing/cards/${encodeURIComponent(card.externalId)}`, connection.accountId,
        { status: 'canceled', cancellation_reason: 'lost' }, `karmax-disconnect-revoke-${card.id}`);
      (await this.requireStore().updateCard(card.id, { status: 'canceled', available: 0 }));
    }
    const form = new URLSearchParams({
      client_id: (await this.clientId())!,
      stripe_user_id: connection.accountId,
    });
    const response = await this.fetcher('https://connect.stripe.com/oauth/deauthorize', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.secret(STRIPE_SECRET_KEY_HANDLE, 'STRIPE_SECRET_KEY')!}`,
        'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const value = await response.json().catch(() => ({})) as any;
    if (!response.ok) throw new Error(value.error_description ?? value.error ?? `Stripe deauthorization returned ${response.status}`);
    (await this.store!.deletePaymentConnection(organizationId, this.name));
  }
  async provisionCard(spec: CardSpec): Promise<Card> {
    if (!spec.cardholderId) throw new Error('Stripe Issuing cardholder is required');
    if (!Number.isSafeInteger(spec.cap) || spec.cap <= 0) throw new Error('card cap must be a positive number of cents');
    if (!this.hasSecret(STRIPE_WEBHOOK_SECRET_HANDLE, 'STRIPE_WEBHOOK_SECRET'))
      throw new Error('A Stripe webhook signing secret is required before issuing active cards');
    const organizationId = spec.organizationId
      ?? (spec.scope === 'organization' ? spec.scopeId : spec.scope === 'project'
        ? (await this.requireStore().getProject(spec.scopeId!))?.organizationId : 'org_personal');
    if (!organizationId) throw new Error('card organization is required');
    const connection = (await this.connection(organizationId));
    if (!spec.label.trim() || (await this.requireStore().listOrganizationCards(organizationId))
      .some(card => card.label.trim().toLowerCase() === spec.label.trim().toLowerCase()))
      throw new Error('Card name must be unique in the organization');
    const balance = await this.balance(organizationId);
    const id = newId('card');
    const currency = (spec.currency ?? 'usd').toLowerCase();
    const remote = await this.request('POST', '/v1/issuing/cards', connection.accountId, {
      cardholder: spec.cardholderId,
      currency,
      type: 'virtual',
      status: 'inactive',
      'spending_controls[spending_limits][0][amount]': spec.cap,
      'spending_controls[spending_limits][0][interval]': 'all_time',
      'spending_controls[spending_limits_currency]': currency,
      'metadata[karmax_card_id]': id,
      'metadata[karmax_organization_id]': organizationId,
    }, `karmax-card-${id}`);
    const card: Card = {
      id, provider: this.name, scope: spec.scope, scopeId: spec.scopeId, label: spec.label,
      cap: spec.cap, available: balance.available, merchantLock: spec.merchantLock,
      externalId: remote.id, currency, status: 'inactive', cardholderId: spec.cardholderId,
      last4: remote.last4, createdAt: Date.now(),
    };
    try {
      await this.requireStore().createCard(card);
      await this.request('POST', `/v1/issuing/cards/${encodeURIComponent(remote.id)}`, connection.accountId,
        { status: 'active' }, `karmax-activate-${id}`);
      await this.requireStore().updateCard(id, { status: 'active' });
      return { ...card, status: 'active' };
    } catch (error) {
      await this.request('POST', `/v1/issuing/cards/${encodeURIComponent(remote.id)}`, connection.accountId,
        { status: 'canceled', cancellation_reason: 'lost' }, `karmax-failed-provision-${id}`);
      await this.requireStore().updateCard(id, { status: 'canceled', available: 0 });
      throw error;
    }
  }
  async getCard(cardId: string): Promise<Card | undefined> {
    const card = (await this.store?.getCard(cardId)) as Card | undefined;
    if (!card || card.provider !== this.name || !card.externalId) return undefined;
    const connection = (await this.connection((await this.organizationForCard(card))));
    const remote = await this.request('GET', `/v1/issuing/cards/${encodeURIComponent(card.externalId)}`, connection.accountId);
    const balance = await this.balance((await this.organizationForCard(card)));
    (await this.store!.updateCard(card.id, { status: remote.status, last4: remote.last4, available: balance.available }));
    return (await this.store!.getCard(card.id));
  }
  async fund(): Promise<void> {
    throw new Error('Stripe cards draw from the organization Issuing balance; fund it in Stripe');
  }
  async authorize(): Promise<AuthorizeResult> {
    return { ok: true, reason: 'reserved for Stripe real-time authorization' };
  }
  async balance(organizationId: string): Promise<PaymentBalance> {
    const connection = (await this.connection(organizationId));
    const value = await this.request('GET', '/v1/balance', connection.accountId);
    const currency = String(((await this.store!.getSettings(`organization:${organizationId}`, 'payments')) as any)?.currency ?? 'usd');
    const amount = Number(value.issuing?.available?.find((entry: any) => entry.currency === currency)?.amount ?? 0);
    return { available: amount, currency,
      fundingUrl: `https://dashboard.stripe.com${connection.livemode ? '' : '/test'}/connect/accounts/${connection.accountId}/issuing/balance` };
  }
  async revoke(cardId: string): Promise<void> {
    const card = (await this.store?.getCard(cardId)) as Card | undefined;
    if (!card?.externalId || card.provider !== this.name) throw new Error('no such Stripe card');
    const connection = (await this.connection((await this.organizationForCard(card))));
    await this.request('POST', `/v1/issuing/cards/${encodeURIComponent(card.externalId)}`,
      connection.accountId, { status: 'canceled', cancellation_reason: 'lost' }, `karmax-revoke-${card.id}`);
    (await this.store!.updateCard(card.id, { status: 'canceled', available: 0 }));
  }
  async listCardholders(organizationId: string): Promise<any[]> {
    const connection = (await this.connection(organizationId));
    const value = await this.request('GET', '/v1/issuing/cardholders?limit=100', connection.accountId);
    return (value.data ?? []).map((holder: any) => ({
      id: holder.id, name: holder.name, type: holder.type, status: holder.status,
      requirements: holder.requirements,
    }));
  }
  async createCardholder(organizationId: string, input: PaymentCardholderInput): Promise<any> {
    const connection = (await this.connection(organizationId));
    const name = input.name.trim();
    const address = input.address;
    if (!name) throw new Error('cardholder name is required');
    if (name.length > 24) throw new Error('cardholder name must be 24 characters or fewer');
    if (!address.line1.trim() || !address.city.trim() || !address.postalCode.trim())
      throw new Error('cardholder billing street, city, and postal code are required');
    if (!/^[A-Za-z]{2}$/.test(address.country.trim()))
      throw new Error('cardholder billing country must be a two-letter country code');
    if (input.type === 'individual' && (!input.firstName?.trim() || !input.lastName?.trim() || !input.dob))
      throw new Error('individual cardholders require legal first name, last name, and date of birth');
    const p: Record<string, unknown> = {
      type: input.type, name, status: 'active', email: input.email,
      phone_number: input.phone,
      'billing[address][line1]': address.line1.trim(),
      'billing[address][line2]': address.line2?.trim(),
      'billing[address][city]': address.city.trim(),
      'billing[address][state]': address.state?.trim(),
      'billing[address][postal_code]': address.postalCode.trim(),
      'billing[address][country]': address.country.trim().toUpperCase(),
      'metadata[karmax_organization_id]': organizationId,
    };
    if (input.type === 'individual') {
      p['individual[first_name]'] = input.firstName;
      p['individual[last_name]'] = input.lastName;
      p['individual[dob][day]'] = input.dob?.day;
      p['individual[dob][month]'] = input.dob?.month;
      p['individual[dob][year]'] = input.dob?.year;
    }
    return this.request('POST', '/v1/issuing/cardholders', connection.accountId, p,
      `karmax-cardholder-${organizationId}-${crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 24)}`);
  }
  async retrieveCardDetails(cardId: string): Promise<{ number: string; cvc: string; expMonth: number; expYear: number }> {
    const card = (await this.store?.getCard(cardId)) as Card | undefined;
    if (!card?.externalId || card.provider !== this.name) throw new Error('no such Stripe card');
    const connection = (await this.connection((await this.organizationForCard(card))));
    const remote = await this.request('GET',
      `/v1/issuing/cards/${encodeURIComponent(card.externalId)}?expand[]=number&expand[]=cvc`, connection.accountId);
    if (!remote.number || !remote.cvc) throw new Error('Stripe did not return virtual card details');
    return { number: remote.number, cvc: remote.cvc, expMonth: remote.exp_month, expYear: remote.exp_year };
  }
  webhookSignatureValid(raw: Buffer, signature: string | undefined, now = Date.now()): boolean {
    const secret = this.secret(STRIPE_WEBHOOK_SECRET_HANDLE, 'STRIPE_WEBHOOK_SECRET');
    if (!secret || !signature) return false;
    const parts = signature.split(',').map((part) => part.split('=', 2));
    const timestamp = Number(parts.find(([key]) => key === 't')?.[1]);
    const signatures = parts.filter(([key]) => key === 'v1').map(([, value]) => value);
    if (!Number.isFinite(timestamp) || Math.abs(now / 1000 - timestamp) > 300) return false;
    const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${raw.toString('utf8')}`).digest('hex');
    return signatures.some((value) => value?.length === expected.length
      && crypto.timingSafeEqual(Buffer.from(value), Buffer.from(expected)));
  }
  async handleWebhook(raw: Buffer, signature?: string): Promise<{ status: number; body: any; stripeVersion?: string }> {
    if (!this.webhookSignatureValid(raw, signature)) return { status: 400, body: { error: 'invalid Stripe signature' } };
    const event = JSON.parse(raw.toString('utf8')) as any;
    const previous = (await this.store!.getPaymentEvent(this.name, event.id));
    if (previous?.decision) return { status: 200, body: previous.decision, stripeVersion: STRIPE_API_VERSION };
    const connection = event.account ? (await this.store!.getPaymentConnectionByAccount(this.name, event.account)) : undefined;
    if (!connection) return { status: 200, body: { received: true } };
    const object = event.data?.object ?? {};
    if (event.type === 'issuing_authorization.request') {
      const externalCardId = typeof object.card === 'string' ? object.card : object.card?.id;
      const card = externalCardId ? (await this.store!.getCardByExternalId(this.name, externalCardId)) : undefined;
      const amount = Number(object.pending_request?.amount ?? object.amount ?? 0);
      const merchant = object.merchant_data?.name ?? object.merchant_data?.url;
      let decision: { approved: boolean } = { approved: false };
      if (card && card.status === 'active' && (await this.organizationForCard(card)) === connection.organizationId
        && String(object.currency ?? card.currency ?? 'usd').toLowerCase() === String(card.currency ?? 'usd').toLowerCase()) {
        // `amount` is what the rail is really authorizing, which the reservation
        // is only an upper bound on — consume it at that figure, not at the bound.
        const request = (await this.store!.findPaymentAuthorization(card.id, amount, merchant));
        if (request && (await this.store!.consumePaymentAuthorization(request.id, object.id, amount))) {
          decision = { approved: true };
          (await this.store!.upsertPaymentTransaction({
            organizationId: connection.organizationId, projectId: request.projectId, taskId: request.taskId,
            cardId: card.id, spendRequestId: request.id, provider: this.name, providerId: object.id,
            kind: 'authorization', status: 'approved', amount, currency: object.currency,
            merchant, raw: object, createdAt: Number(object.created ?? Date.now() / 1000) * 1000,
          }));
        }
      }
      (await this.store!.recordPaymentEvent({ provider: this.name, eventId: event.id,
        organizationId: connection.organizationId, type: event.type, decision }));
      return { status: 200, body: decision, stripeVersion: this.env.STRIPE_API_VERSION || STRIPE_API_VERSION };
    }
    (await this.reconcileEvent(connection.organizationId, event));
    (await this.store!.recordPaymentEvent({ provider: this.name, eventId: event.id,
      organizationId: connection.organizationId, type: event.type }));
    return { status: 200, body: { received: true } };
  }
  private async reconcileEvent(organizationId: string, event: any): Promise<void> {
    const object = event.data?.object ?? {};
    const externalCardId = typeof object.card === 'string' ? object.card : object.card?.id;
    const card = externalCardId ? (await this.store!.getCardByExternalId(this.name, externalCardId)) : undefined;
    if (card && (await this.organizationForCard(card)) !== organizationId) return;
    if (event.type === 'issuing_card.updated' && card) {
      (await this.store!.updateCard(card.id, { status: object.status, last4: object.last4 }));
      return;
    }
    if (event.type === 'account.application.deauthorized') {
      for (const candidate of (await this.store!.listOrganizationCards(organizationId))
        .filter((value) => value.provider === this.name))
        (await this.store!.updateCard(candidate.id, { status: 'canceled', available: 0 }));
      (await this.store!.deletePaymentConnection(organizationId, this.name));
      return;
    }
    if (event.type.startsWith('issuing_dispute.')) {
      const transactionId = typeof object.transaction === 'string'
        ? object.transaction : object.transaction?.id;
      const transaction = transactionId
        ? (await this.store!.getPaymentTransactionByProviderId(this.name, transactionId))
        : undefined;
      (await this.store!.upsertPaymentTransaction({
        organizationId,
        projectId: transaction?.projectId,
        taskId: transaction?.taskId,
        cardId: transaction?.cardId,
        spendRequestId: transaction?.spendRequestId,
        provider: this.name,
        providerId: object.id,
        kind: 'dispute',
        status: object.status ?? event.type.slice('issuing_dispute.'.length),
        amount: Number(object.amount ?? transaction?.amount ?? 0),
        currency: object.currency ?? transaction?.currency ?? 'usd',
        merchant: transaction?.merchant,
        raw: object,
        createdAt: Number(object.created ?? Date.now() / 1000) * 1000,
      }));
      return;
    }
    if (!card || (!event.type.startsWith('issuing_authorization.') && !event.type.startsWith('issuing_transaction.'))) return;
    const authorizationId = event.type.startsWith('issuing_authorization.')
      ? object.id : typeof object.authorization === 'string' ? object.authorization : object.authorization?.id;
    const request = authorizationId
      ? (await this.store!.listPaymentSpendRequests({ organizationId })).find((value) => value.providerAuthorizationId === authorizationId)
      : undefined;
    (await this.store!.upsertPaymentTransaction({
      organizationId, projectId: request?.projectId, taskId: request?.taskId, cardId: card.id,
      spendRequestId: request?.id, provider: this.name, providerId: object.id,
      kind: event.type.startsWith('issuing_transaction.') ? 'transaction' : 'authorization',
      status: object.status ?? (object.approved ? 'approved' : 'declined'),
      amount: Number(object.amount ?? 0), currency: object.currency ?? card.currency ?? 'usd',
      merchant: object.merchant_data?.name, raw: object,
      createdAt: Number(object.created ?? Date.now() / 1000) * 1000,
    }));
    if (request && event.type.startsWith('issuing_authorization.')) {
      if (object.status === 'reversed')
        (await this.store!.updatePaymentSpendRequest(request.id, { status: 'reversed', reason: 'authorization reversed' }));
      else if (object.approved === false)
        (await this.store!.updatePaymentSpendRequest(request.id, { status: 'denied', reason: 'authorization declined by Stripe' }));
    }
    if (request && event.type.startsWith('issuing_transaction.')) {
      const transactionType = String(object.type ?? '').toLowerCase();
      const transactionStatus = String(object.status ?? '').toLowerCase();
      // Stripe signs an issuing transaction from the cardholder's side — a capture
      // is negative, a refund positive. Only the magnitude is money that moved.
      const moved = Math.abs(Number(object.amount ?? 0)) || request.amount;
      if (transactionType === 'refund' || transactionStatus === 'reversed') {
        // A refund can be partial: it releases what came back, not the whole
        // charge. Only when nothing is left does the request stop being a spend.
        const amount = Math.max(0, request.amount - moved);
        (await this.store!.updatePaymentSpendRequest(request.id, amount
          ? { amount }
          : { status: 'reversed', reason: 'refunded at the rail' }));
      } else if (transactionType === 'capture' || transactionStatus === 'complete') {
        // The capture is the final word on the amount — a partial capture, a tip,
        // or an FX difference all land here, and all of them are what the cap owes.
        (await this.store!.updatePaymentSpendRequest(request.id, { status: 'settled', amount: moved }));
      }
    }
  }
}

export class PaymentRegistry {
  private providers = new Map<string, PaymentProvider>();
  constructor(private store?: Store) {}
  register(p: PaymentProvider) {
    this.providers.set(p.name, p);
  }
  get(name = 'mock'): PaymentProvider {
    const p = this.providers.get(name);
    if (!p) throw new Error(`no payment provider "${name}"`);
    return p;
  }
  async list(ctx?: PaymentConnectionContext): Promise<ProviderInfo[]> {
    return (await __asyncCollections.map([...this.providers.values()], async (p) => (await p.describe(ctx))));
  }
  forCard(card: Pick<Card, 'provider'>): PaymentProvider {
    return this.get(card.provider);
  }
  async active(organizationId: string): Promise<PaymentProvider> {
    const selected = (this.providers.values().next().value as PaymentProvider | undefined)?.name ?? 'mock';
    const name = ((await this.store?.getSettings(`organization:${organizationId}`, 'payments')) as any)?.provider
      ?? selected;
    const provider = this.providers.get(name);
    return provider && (await provider.describe({ organizationId })).connected ? provider : this.get('mock');
  }
}

// ── the four-outcome decision (pure; SPEC §7.6 + the converged design) ────────

export type SpendStatus = 'granted' | 'needs_approval' | 'needs_funding' | 'denied';
export interface SpendDecision {
  status: SpendStatus;
  reason?: string;
  shortfall?: number; // for needs_funding: amount the human must add
}

export interface SpendInputs {
  amount: number;
  /** the agent's allowance for this scope (cents); undefined = unlimited policy. */
  allowance?: number;
  /** total already spent against the allowance (cents). */
  spent: number;
  /** @deprecated Ignored. Approval depends only on the cumulative task budget. */
  threshold?: number;
  /** funds available on the card (cents). */
  available: number;
  /** the card's hard cap (cents) — a single charge over this is declined by the rail. */
  hardCap: number;
  merchant?: string;
  merchantLock?: string[];
}

/**
 * Decide a spend: hard cap → denied; over budget → needs_approval;
 * within policy but underfunded → needs_funding; else
 * granted. Funding availability is orthogonal to the policy limits.
 */
export function evaluateSpend(i: SpendInputs): SpendDecision {
  if (i.amount <= 0) return { status: 'denied', reason: 'amount must be positive' };
  if (i.merchantLock?.length && (!i.merchant || !i.merchantLock.includes(i.merchant))) {
    return { status: 'denied', reason: i.merchant
      ? `merchant "${i.merchant}" not allowed on this card`
      : 'merchant is required for a merchant-locked card' };
  }
  if (i.amount > i.hardCap) return { status: 'denied', reason: 'exceeds the card hard cap' };
  if (i.allowance !== undefined && i.spent + i.amount > i.allowance) {
    return { status: 'needs_approval', reason: `over the task budget (${i.spent}+${i.amount} > ${i.allowance})` };
  }
  if (i.amount > i.available) {
    return { status: 'needs_funding', reason: 'insufficient funds on the card', shortfall: i.amount - i.available };
  }
  return { status: 'granted' };
}

// ── the service that ties policy (settings) + funds (provider) together ───────

export interface SpendCtx {
  projectId: string;
  taskId: string;
  /** Owning organization; cards are org-scoped so a task only spends from its
   *  own tenant's cards. Falls back to the project's org when omitted. */
  organizationId?: string;
  /** Optional explicit card attenuation. No use-card capability means all cards
   * visible to the project; once present, only matching cards are eligible. */
  capabilities?: string[];
}
export interface SpendArgs {
  amount: number;
  merchant?: string;
  why?: string;
  cardId?: string;
  cardName?: string;
}
export interface SpendResult extends SpendDecision {
  cardId?: string;
  transactionId?: string;
  requestId?: string;
  fundingUrl?: string;
}

export class BudgetService {
  constructor(
    private store: Store,
    private rails: PaymentProvider | PaymentRegistry,
  ) {}

  private provider(card: Card): PaymentProvider {
    return this.rails instanceof PaymentRegistry ? this.rails.forCard(card) : this.rails;
  }

  async policy(projectId: string, taskId?: string): Promise<PaymentPolicy> {
    const policy = await resolvePaymentPolicy(this.store, projectId, taskId);
    if (taskId) for (const ancestorId of (await this.store.paymentBudgetFamily(taskId)).ancestorIds) {
      const ancestor = await this.store.getTask(ancestorId);
      const inherited = await resolvePaymentPolicy(this.store, ancestor!.projectId, ancestorId);
      if (inherited.budget !== null) policy.budget = policy.budget === null ? inherited.budget : Math.min(policy.budget, inherited.budget);
      if (inherited.cardIds) policy.cardIds = policy.cardIds ? policy.cardIds.filter(id => inherited.cardIds!.includes(id)) : inherited.cardIds;
    }
    return policy;
  }

  private async spent(taskId: string): Promise<number> {
    return (await this.store.paymentSpent(taskId, true));
  }

  /**
   * What is left of the card's ceiling: its cap minus everything already reserved
   * or charged on it. The cap is CUMULATIVE, so this has to be recounted at every
   * point that can commit spend — a per-request check passes independently for
   * each of several queued requests, and letting them all through is exactly the
   * breach the cap exists to prevent (the budget coordinator has guarded its own
   * approval path this way from the start; see src/coordinators/budget.ts).
   *
   * A rail without its own ceiling can only run out of funds, never breach a cap,
   * so an oversized request there asks for a top-up rather than being denied.
   */
  private async remainingCap(provider: PaymentProvider, card: Card): Promise<number> {
    return provider.enforcesCardCap === false ? Number.MAX_SAFE_INTEGER
      : Math.max(0, card.cap - (await this.store.cardPaymentSpent(card.id)));
  }

  async cards(ctx: SpendCtx): Promise<Card[]> {
    const visible = (await this.store.listCards(ctx.projectId, ctx.organizationId))
      .filter((card) => card.status !== 'canceled' && card.status !== 'inactive') as Card[];
    const storedCaps = ((await this.store.getTask(ctx.taskId))?.params?._authorization as { capabilities?: string[] } | undefined)?.capabilities;
    const permissions = new PermissionRequests(this.store,
      ctx.organizationId ?? (await this.store.getProject(ctx.projectId))?.organizationId ?? 'org_personal');
    const approved = await permissions.extensionCaps(ctx.taskId);
    const liveCaps = storedCaps || approved.length ? [...(storedCaps ?? []), ...approved] : undefined;
    let scoped = ctx.capabilities && liveCaps ? attenuate(ctx.capabilities, liveCaps) : ctx.capabilities ?? liveCaps ?? [];
    for (const ancestorId of (await this.store.paymentBudgetFamily(ctx.taskId)).ancestorIds) {
      const ancestor = await this.store.getTask(ancestorId);
      scoped = attenuate(scoped, [
        ...((ancestor?.params?._authorization as { capabilities?: string[] } | undefined)?.capabilities ?? []),
        ...await permissions.extensionCaps(ancestorId),
      ]);
    }
    const selected = (await this.policy(ctx.projectId, ctx.taskId)).cardIds;
    return visible.filter(card => (!selected || selected.includes(card.id))
      && allows(scoped, `use-card:${card.id}`));
  }

  async claimFill(ctx: SpendCtx, requestId: string): Promise<{ request: any; domain: string }> {
    return this.store.paymentTransaction(async () => {
      const request = await this.store.getPaymentSpendRequest(requestId);
      if (!request || request.taskId !== ctx.taskId || request.projectId !== ctx.projectId
        || !['authorized', 'settled'].includes(request.status)
        || request.expiresAt <= Date.now() || request.createdAt + 30 * 60_000 <= Date.now())
        throw new Error('payment request is not an active reservation for this task');
      if (!(await this.cards(ctx)).some(card => card.id === request.cardId))
        throw new Error('card is no longer selected for this task');
      let domain = '';
      try {
        const raw = String(request.merchant ?? '');
        const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
        if (url.protocol === 'https:' && !url.username && !url.password) domain = url.hostname;
      } catch {}
      if (!getDomain(domain, { allowPrivateDomains: true }))
        throw new Error('request_spend merchant must be a checkout domain, not a public suffix');
      const key = `payment-fill:${request.id}`;
      const attempts = Number(await this.store.kvGet(key) ?? 0);
      if (!Number.isSafeInteger(attempts) || attempts >= 3) throw new Error('payment fill attempt limit reached');
      await this.store.kvSet(key, String(attempts + 1));
      return { request, domain };
    });
  }

  private async existing(ctx: SpendCtx, args: SpendArgs): Promise<any> {
    return (await this.store.listPaymentSpendRequests({ taskId: ctx.taskId })).find((request) =>
      ['authorizing', 'pending_approval', 'needs_funding', 'authorized', 'consumed', 'settled'].includes(request.status)
      && (['authorizing', 'pending_approval', 'needs_funding'].includes(request.status) || request.expiresAt > Date.now())
      && request.amount === args.amount
      && (!args.cardId || request.cardId === args.cardId)
      && (request.merchant ?? undefined) === args.merchant
      && (request.why ?? undefined) === args.why);
  }

  private result(request: any): SpendResult {
    const status: SpendStatus = ['pending_approval', 'authorizing'].includes(request.status) ? 'needs_approval'
      : ['authorized', 'consumed', 'settled'].includes(request.status) ? 'granted'
        : request.status === 'needs_funding' ? 'needs_funding' : 'denied';
    return { status, reason: request.reason ?? undefined, shortfall: request.shortfall ?? undefined,
      cardId: request.cardId ?? undefined, requestId: request.id,
      transactionId: request.providerAuthorizationId ?? undefined };
  }

  /** Decide and durably record a spend. Stripe grants are short-lived
   * authorization reservations consumed by its real-time webhook; local grants
   * settle immediately. */
  async request(ctx: SpendCtx, args: SpendArgs): Promise<SpendResult> {
    if (!Number.isSafeInteger(args.amount) || args.amount <= 0)
      return { status: 'denied', reason: 'amount must be a positive number of cents' };
    if (args.cardName) {
      const matches = (await this.cards(ctx)).filter(card => card.label.trim().toLowerCase() === args.cardName!.trim().toLowerCase());
      if (matches.length !== 1 || (args.cardId && args.cardId !== matches[0]!.id))
        return { status: 'denied', reason: 'Card name must identify one permitted card' };
      args = { ...args, cardId: matches[0]!.id };
    }
    const duplicate = (await this.existing(ctx, args));
    if (duplicate) {
      if (duplicate.cardId && !(await this.cards(ctx)).some(c => c.id === duplicate.cardId))
        return { status: 'denied', reason: 'card is no longer selected for this task', requestId: duplicate.id };
      return this.result(duplicate);
    }
    const organizationId = ctx.organizationId ?? (await this.store.getProject(ctx.projectId))?.organizationId ?? 'org_personal';
    const visibleCards = (await this.cards(ctx));
    const card = args.cardId
      ? visibleCards.find((candidate) => candidate.id === args.cardId)
      : visibleCards[0];
    if (!card && args.cardId) return { status: 'denied', reason: 'the requested card is not available to this task' };
    if (!card) {
      const reason = 'no card is selected for this task — choose a card in task parameters';
      const pending = (await this.store.createPaymentSpendRequest({ organizationId, projectId: ctx.projectId,
        taskId: ctx.taskId, amount: args.amount, merchant: args.merchant, why: args.why,
        status: 'needs_funding', reason, shortfall: args.amount }));
      return this.result(pending);
    }
    const provider = this.provider(card);
    const refreshed = await provider.getCard(card.id) ?? card;
    const reserved = (await this.store.paymentTransaction(async () => {
      if (!(await this.cards(ctx)).some(c => c.id === card.id))
        return { request: { status: 'denied', reason: 'card is no longer selected for this task' }, created: false };
      const duplicate = (await this.existing(ctx, args));
      if (duplicate) return { request: duplicate, created: false };
      const { budget } = (await this.policy(ctx.projectId, ctx.taskId));
      const decision = evaluateSpend({ amount: args.amount, allowance: budget ?? undefined,
        spent: (await this.spent(ctx.taskId)), available: refreshed.available,
        hardCap: (await this.remainingCap(provider, refreshed)), merchant: args.merchant,
        merchantLock: refreshed.merchantLock });
      const status = decision.status === 'granted'
        ? provider.authorizationMode === 'webhook' ? 'authorized' : 'authorizing'
        : decision.status === 'needs_approval' ? 'pending_approval' : decision.status;
      const request = (await this.store.createPaymentSpendRequest({ organizationId, projectId: ctx.projectId,
        taskId: ctx.taskId, cardId: card.id, amount: args.amount, currency: card.currency,
        merchant: args.merchant, why: args.why, status, reason: decision.reason, shortfall: decision.shortfall }));
      return { request, created: true };
    }));
    const pending = reserved.request;
    if (!reserved.created || pending.status !== 'authorizing') {
      const fundingUrl = pending.status === 'needs_funding' ? (await provider.balance(organizationId)).fundingUrl : undefined;
      return { ...this.result(pending), fundingUrl };
    }
    return this.authorizeImmediate(provider, pending);
  }

  /** Immediate rails debit local card state. Keep that debit and settlement
   * atomic so expiry cannot release the allowance while a charge is applying. */
  private async authorizeImmediate(provider: PaymentProvider, request: any, resolvedBy?: string): Promise<SpendResult> {
    const expired = new Error('payment reservation expired during authorization');
    try {
      return await this.store.paymentTransaction(async () => {
        await this.store.expirePaymentSpendRequests();
        const current = await this.store.getPaymentSpendRequest(request.id);
        if (current.status !== 'authorizing') return this.result(current);
        const auth = await provider.authorize(current.cardId, current.amount, current.merchant ?? undefined);
        if (current.expiresAt <= Date.now()) throw expired;
        if (!auth.ok) return this.result(await this.store.updatePaymentSpendRequest(current.id, {
          status: 'needs_funding', reason: auth.reason ?? 'authorization declined', shortfall: current.amount, resolvedBy,
        }));
        await this.store.upsertPaymentTransaction({ organizationId: current.organizationId, projectId: current.projectId,
          taskId: current.taskId, cardId: current.cardId, spendRequestId: current.id, provider: provider.name,
          providerId: auth.transactionId!, kind: 'transaction', status: 'settled',
          amount: current.amount, currency: current.currency, merchant: current.merchant });
        return this.result(await this.store.updatePaymentSpendRequest(current.id, {
          status: 'settled', providerAuthorizationId: auth.transactionId,
          ...(resolvedBy ? { reason: 'approved', resolvedBy } : {}),
        }));
      });
    } catch (error) {
      if (error !== expired) throw error;
      // The failed transaction rolled back the local debit. Expire and audit
      // the reservation separately so it stays released after the rollback.
      await this.store.expirePaymentSpendRequests();
      return this.result(await this.store.getPaymentSpendRequest(request.id));
    }
  }

  /** Re-evaluate the oldest requests first; later requests cannot jump the queue. */
  async reconcileTask(ctx: SpendCtx): Promise<SpendResult[]> {
    const results: SpendResult[] = [];
    const pending = (await this.store.listPaymentSpendRequests({ taskId: ctx.taskId }))
      .filter(r => r.status === 'pending_approval').reverse();
    for (const request of pending) {
      const policy = (await this.policy(ctx.projectId, ctx.taskId));
      if (policy.budget !== null && (await this.spent(ctx.taskId)) + request.amount > policy.budget) break;
      if (!(await this.cards(ctx)).some(card => card.id === request.cardId)) break;
      const result = await this.approve(request.id, 'system:task-budget', true);
      results.push(result);
      if (result.status !== 'granted') break;
    }
    return results;
  }

  async approve(requestId: string, resolvedBy: string, withinBudget = false): Promise<SpendResult> {
    const request = (await this.store.getPaymentSpendRequest(requestId));
    if (!request) return { status: 'denied', reason: 'spend request not found' };
    if (!['pending_approval', 'needs_funding'].includes(request.status)) return this.result(request);
    const card = request.cardId
      ? (await this.store.getCard(request.cardId)) as Card | undefined
      : (await this.cards({
        projectId: request.projectId,
        taskId: request.taskId,
        organizationId: request.organizationId,
      }))[0];
    if (card && !(await this.cards({ projectId: request.projectId, taskId: request.taskId, organizationId: request.organizationId })).some(c => c.id === card.id))
      return { status: 'denied', reason: 'card is no longer selected for this task', requestId };
    if (!card) return this.result((await this.store.updatePaymentSpendRequest(request.id,
      { status: 'denied', reason: 'card no longer exists', resolvedBy })));
    if (!request.cardId) (await this.store.setPaymentSpendRequestCard(request.id, card.id));
    const provider = this.provider(card);
    const refreshed = await provider.getCard(card.id) ?? card;
    let wonClaim = false;
    const claimed = (await this.store.paymentTransaction(async () => {
      const current = (await this.store.getPaymentSpendRequest(requestId))!;
      if (!['pending_approval', 'needs_funding'].includes(current.status)) return current;
      const policy = (await this.policy(request.projectId, request.taskId));
      if (withinBudget && policy.budget !== null && (await this.spent(request.taskId)) + request.amount > policy.budget) return current;
      if (!(await this.cards({ projectId: request.projectId, taskId: request.taskId })).some(c => c.id === card.id)) return current;
      if (refreshed.status === 'canceled' || refreshed.status === 'inactive')
        return (await this.store.updatePaymentSpendRequest(request.id,
          { status: 'denied', reason: 'card is not active', resolvedBy }));
      // Re-count the ceiling here. Everything else queued while this request waited
      // for a human has been charged in the meantime, and on a webhook rail approval
      // is the LAST place a cap breach can be caught: it never calls `authorize()`.
      if (request.amount > (await this.remainingCap(provider, refreshed))) {
        return (await this.store.updatePaymentSpendRequest(request.id,
          { status: 'denied', reason: 'exceeds the card hard cap', resolvedBy }));
      }
      if (refreshed.available < request.amount) {
        return (await this.store.updatePaymentSpendRequest(request.id, {
          status: 'needs_funding', reason: 'insufficient funds on the card',
          shortfall: request.amount - refreshed.available, resolvedBy,
        }));
      }
      if (provider.authorizationMode === 'webhook') {
        return (await this.store.updatePaymentSpendRequest(request.id,
          { status: 'authorized', reason: 'approved', shortfall: 0, resolvedBy, expiresAt: Date.now() + 30 * 60_000 }));
      }
      wonClaim = true;
      return (await this.store.updatePaymentSpendRequest(request.id, { status: 'authorizing', resolvedBy, expiresAt: Date.now() + 30 * 60_000 }));
    }));
    if (!wonClaim) return this.result(claimed);
    return this.authorizeImmediate(provider, claimed, resolvedBy);
  }

  async deny(requestId: string, resolvedBy: string): Promise<SpendResult> {
    return (await this.store.paymentTransaction(async () => {
      const request = (await this.store.getPaymentSpendRequest(requestId));
      if (!request) return { status: 'denied', reason: 'spend request not found' };
      // Same terminal-status guard `approve` has, and for a sharper reason: money.
      // `paymentSpent`/`cardPaymentSpent` total only consumed/settled/live-authorized
      // rows, so flipping an already-settled request to `denied` erased it from the
      // task's allowance and the card's cap while the charge had already gone
      // through — the agent got that budget back and could spend it a second time,
      // and the transaction ledger disagreed with the allowance from then on.
      // A reviewer clicking Deny on a stale list is all it took.
      if (!['pending_approval', 'needs_funding'].includes(request.status)) return this.result(request);
      return this.result((await this.store.updatePaymentSpendRequest(request.id,
        { status: 'denied', reason: 'denied by reviewer', resolvedBy })));
    }));
  }

  /** Back-compatible test/helper entry point. */
  async settleApproved(ctx: SpendCtx, args: SpendArgs): Promise<SpendResult> {
    const existing = (await this.store.listPaymentSpendRequests({ taskId: ctx.taskId }))
      .find((request) => request.amount === args.amount && (!args.cardId || request.cardId === args.cardId)
        && ['pending_approval', 'needs_funding'].includes(request.status));
    if (existing) return this.approve(existing.id, 'system:settle');
    const first = await this.request(ctx, args);
    return first.requestId ? this.approve(first.requestId, 'system:settle') : first;
  }
}

export interface PaymentPolicy { cardIds: string[]; budget: number | null }

/** Defaults apply to new tasks; an explicit empty selection permits no cards. */
export async function resolvePaymentPolicy(store: Store, projectId: string, taskId?: string): Promise<PaymentPolicy> {
  const org = (await store.getProject(projectId))?.organizationId ?? 'org_personal';
  const g = ((await store.getSettings(`organization:${org}`, 'payments'))
    ?? (org === 'org_personal' ? (await store.getSettings('global', 'payments')) : undefined) ?? {}) as any;
  const p = ((await store.getSettings(projectId, 'payments')) ?? {}) as any;
  const t = taskId ? ((await store.getTask(taskId))?.params as any)?.paymentPolicy : undefined;
  const layer = t ?? p;
  return { cardIds: layer.cardIds ?? g.cardIds ?? (await store.listCards(projectId, org)).filter(c => c.status !== 'canceled').map(c => c.id),
    budget: Object.hasOwn(layer, 'budget') ? layer.budget : layer.allowance
      ?? (Object.hasOwn(g, 'budget') ? g.budget : g.allowance ?? 0) };
}

export async function validatePaymentPolicy(store: Store, projectId: string | undefined, organizationId: string, value: unknown): Promise<void> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid payment policy');
  const p = value as PaymentPolicy;
  if (p.budget !== null && (!Number.isSafeInteger(p.budget) || p.budget < 0))
    throw new Error('Budget must be a non-negative amount in cents');
  const cards = (await store.listCards(projectId, organizationId));
  if (!Array.isArray(p.cardIds) || p.cardIds.some(id => typeof id !== 'string' || !cards.some(c => c.id === id && c.status !== 'canceled' && c.status !== 'inactive')))
    throw new Error('Choose available cards from this organization');
}
