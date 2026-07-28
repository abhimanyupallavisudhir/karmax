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
  describe(ctx?: PaymentConnectionContext): ProviderInfo;
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
    this.store.createCard(card);
    return card;
  }
  async getCard(cardId: string): Promise<Card | undefined> {
    return this.store.getCard(cardId);
  }
  async fund(cardId: string, amount: number): Promise<void> {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('funding amount must be a positive number of cents');
    const c = this.store.getCard(cardId);
    if (!c) throw new Error('no such card');
    this.store.updateCard(cardId, { available: c.available + amount });
  }
  async authorize(cardId: string, amount: number, merchant?: string): Promise<AuthorizeResult> {
    const c = this.store.getCard(cardId);
    if (!c) return { ok: false, reason: 'no such card' };
    if (!Number.isSafeInteger(amount) || amount <= 0) return { ok: false, reason: 'amount must be a positive number of cents' };
    if (c.merchantLock?.length && (!merchant || !c.merchantLock.includes(merchant))) return { ok: false, reason: 'merchant not allowed' };
    if (this.store.cardPaymentSpent(cardId) + amount > c.cap) return { ok: false, reason: 'exceeds card cap' };
    if (amount > c.available) return { ok: false, reason: 'insufficient funds' };
    this.store.updateCard(cardId, { available: c.available - amount });
    return { ok: true, transactionId: newId('txn') };
  }
  describe(): ProviderInfo {
    return { name: this.name, label: 'Local test funds', kind: 'local', available: true, connected: true,
      help: 'Simulated funds for testing payment policy. No real money moves.' };
  }
  async connect(): Promise<ConnectResult> {
    return { status: 'connected', detail: 'Local provider needs no connection — add and fund cards below.' };
  }
  async balance(organizationId: string): Promise<PaymentBalance> {
    return { available: this.store.listOrganizationCards(organizationId)
      .filter((card) => card.provider === this.name).reduce((sum, card) => sum + card.available, 0), currency: 'usd' };
  }
  async revoke(cardId: string): Promise<void> {
    if (!this.store.getCard(cardId)) throw new Error('no such card');
    this.store.updateCard(cardId, { status: 'canceled', available: 0 });
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
    this.broker.registerHandle(cardSecretHandle(card.id), JSON.stringify(details));
    this.store.createCard(card);
    return card;
  }
  async getCard(cardId: string): Promise<Card | undefined> {
    const card = this.store.getCard(cardId) as Card | undefined;
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
    this.store.updateCard(cardId, { available: card.available + amount, cap: card.cap + amount });
  }
  async authorize(cardId: string, amount: number, merchant?: string): Promise<AuthorizeResult> {
    const card = await this.getCard(cardId);
    if (!card) return { ok: false, reason: 'no such card' };
    if (card.status === 'canceled') return { ok: false, reason: 'card is not active' };
    if (!Number.isSafeInteger(amount) || amount <= 0) return { ok: false, reason: 'amount must be a positive number of cents' };
    if (card.merchantLock?.length && (!merchant || !card.merchantLock.includes(merchant)))
      return { ok: false, reason: 'merchant not allowed' };
    if (amount > card.available) return { ok: false, reason: 'exceeds the declared remaining limit' };
    this.store.updateCard(cardId, { available: card.available - amount });
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
    return { available: this.store.listOrganizationCards(organizationId)
      .filter((card) => card.provider === this.name && card.status !== 'canceled')
      .reduce((sum, card) => sum + card.available, 0), currency: 'usd' };
  }
  /** Revoking must destroy the secret, not just hide the row. */
  async revoke(cardId: string): Promise<void> {
    if (!await this.getCard(cardId)) throw new Error('no such card');
    this.broker.deleteHandle(cardSecretHandle(cardId));
    this.store.updateCard(cardId, { status: 'canceled', available: 0 });
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

  private configured(): boolean {
    return Boolean(this.store && this.clientId() && this.hasSecret(STRIPE_SECRET_KEY_HANDLE, 'STRIPE_SECRET_KEY'));
  }
  private clientId(): string | undefined {
    return this.store?.kvGet(STRIPE_CLIENT_ID_KEY)?.trim() || this.env.STRIPE_CLIENT_ID?.trim() || undefined;
  }
  private hasSecret(handle: string, environmentName: 'STRIPE_SECRET_KEY' | 'STRIPE_WEBHOOK_SECRET'): boolean {
    return Boolean(this.broker?.hasHandle(handle) || this.env[environmentName]);
  }
  private secret(handle: string, environmentName: 'STRIPE_SECRET_KEY' | 'STRIPE_WEBHOOK_SECRET'): string | undefined {
    if (this.broker?.hasHandle(handle))
      return this.broker.resolve(handle, { caps: [`use-credential:${handle}`] });
    return this.env[environmentName];
  }
  platformStatus(): StripePlatformStatus {
    const clientId = this.clientId();
    const uiManaged = Boolean(this.store?.kvGet(STRIPE_CLIENT_ID_KEY)
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
  configurePlatform(input: { clientId: string; secretKey?: string; webhookSecret?: string }): StripePlatformStatus {
    const store = this.requireStore();
    if (!this.broker) throw new Error('Karmax encrypted secret storage is unavailable');
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
    store.kvSet(STRIPE_CLIENT_ID_KEY, clientId);
    if (secretKey) this.broker.registerHandle(STRIPE_SECRET_KEY_HANDLE, secretKey);
    if (webhookSecret) this.broker.registerHandle(STRIPE_WEBHOOK_SECRET_HANDLE, webhookSecret);
    return this.platformStatus();
  }
  private requireStore(): Store {
    if (!this.store) throw new Error('Stripe Issuing store is unavailable');
    return this.store;
  }
  private connection(organizationId: string): any {
    const value = this.requireStore().getPaymentConnection(organizationId, this.name);
    if (!value || value.status !== 'ready') throw new Error('Stripe is not connected for this organization');
    return value;
  }
  private organizationForCard(card: Card): string {
    if (card.scope === 'organization') return card.scopeId!;
    if (card.scope === 'project') return this.requireStore().getProject(card.scopeId!)?.organizationId
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
  describe(ctx?: PaymentConnectionContext): ProviderInfo {
    const connection = ctx && this.store?.getPaymentConnection(ctx.organizationId, this.name);
    const available = this.configured();
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
          ? `Connected account ${connection.accountId} needs Stripe card_issuing capability activation before Karmax can issue cards.`
        : available
          ? 'Connect this organization’s Stripe account. The deployment Connect app identifies Karmax; it does not fund cards.'
          : 'An installation administrator must complete Stripe platform setup before organizations can connect.',
    };
  }
  async connect(ctx?: PaymentConnectionContext): Promise<ConnectResult> {
    if (!ctx || !this.configured() || !ctx.redirectUri) return { status: 'unavailable',
      detail: 'Stripe Connect needs deployment client/secret configuration and a public callback URL before each organization can connect its own account.' };
    const existing = this.store!.getPaymentConnection(ctx.organizationId, this.name);
    if (existing?.status === 'ready') return { status: 'connected', detail: `Connected to ${existing.accountId}.` };
    const state = this.store!.createPaymentOAuthState({
      organizationId: ctx.organizationId, userId: ctx.userId, redirectUri: ctx.redirectUri,
    });
    const url = new URL('https://connect.stripe.com/oauth/authorize');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'read_write');
    url.searchParams.set('client_id', this.clientId()!);
    url.searchParams.set('redirect_uri', ctx.redirectUri);
    url.searchParams.set('state', state);
    return { status: 'awaiting_oauth', url: url.toString(),
      detail: 'Authorize this organization’s Stripe account. Its Issuing balance remains separate from every other organization.' };
  }
  async completeOAuth(state: string, code: string): Promise<any> {
    if (!this.configured()) throw new Error('Stripe Connect is not configured');
    const pending = this.store!.consumePaymentOAuthState(state);
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
    const saved = this.store!.upsertPaymentConnection({
      organizationId: pending.organizationId,
      provider: this.name,
      accountId: token.stripe_user_id,
      status: capability === 'active' ? 'ready' : 'attention',
      livemode: Boolean(token.livemode),
      details: { businessName: account.business_profile?.name ?? account.settings?.dashboard?.display_name,
        country: account.country, cardIssuing: capability ?? 'unknown' },
    });
    const settings = this.store!.getSettings(`organization:${pending.organizationId}`, 'payments') ?? {};
    this.store!.setSettings(`organization:${pending.organizationId}`, 'payments', { ...settings, provider: this.name });
    return saved;
  }
  async disconnect(organizationId: string): Promise<void> {
    const connection = this.requireStore().getPaymentConnection(organizationId, this.name);
    if (!connection) throw new Error('Stripe is not connected for this organization');
    for (const card of this.requireStore().listOrganizationCards(organizationId)
      .filter((candidate) => candidate.provider === this.name && candidate.status !== 'canceled')) {
      if (card.externalId) await this.request('POST',
        `/v1/issuing/cards/${encodeURIComponent(card.externalId)}`, connection.accountId,
        { status: 'canceled', cancellation_reason: 'lost' }, `karmax-disconnect-revoke-${card.id}`);
      this.requireStore().updateCard(card.id, { status: 'canceled', available: 0 });
    }
    const form = new URLSearchParams({
      client_id: this.clientId()!,
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
    this.store!.deletePaymentConnection(organizationId, this.name);
  }
  async provisionCard(spec: CardSpec): Promise<Card> {
    if (!spec.cardholderId) throw new Error('Stripe Issuing cardholder is required');
    if (!Number.isSafeInteger(spec.cap) || spec.cap <= 0) throw new Error('card cap must be a positive number of cents');
    if (!this.hasSecret(STRIPE_WEBHOOK_SECRET_HANDLE, 'STRIPE_WEBHOOK_SECRET'))
      throw new Error('A Stripe webhook signing secret is required before issuing active cards');
    const organizationId = spec.organizationId
      ?? (spec.scope === 'organization' ? spec.scopeId : spec.scope === 'project'
        ? this.requireStore().getProject(spec.scopeId!)?.organizationId : 'org_personal');
    if (!organizationId) throw new Error('card organization is required');
    const connection = this.connection(organizationId);
    const id = newId('card');
    const currency = (spec.currency ?? 'usd').toLowerCase();
    const remote = await this.request('POST', '/v1/issuing/cards', connection.accountId, {
      cardholder: spec.cardholderId,
      currency,
      type: 'virtual',
      status: 'active',
      'spending_controls[spending_limits][0][amount]': spec.cap,
      'spending_controls[spending_limits][0][interval]': 'all_time',
      'spending_controls[spending_limits_currency]': currency,
      'metadata[karmax_card_id]': id,
      'metadata[karmax_organization_id]': organizationId,
    }, `karmax-card-${id}`);
    const balance = await this.balance(organizationId);
    const card: Card = {
      id, provider: this.name, scope: spec.scope, scopeId: spec.scopeId, label: spec.label,
      cap: spec.cap, available: balance.available, merchantLock: spec.merchantLock,
      externalId: remote.id, currency, status: remote.status, cardholderId: spec.cardholderId,
      last4: remote.last4, createdAt: Date.now(),
    };
    this.requireStore().createCard(card);
    return card;
  }
  async getCard(cardId: string): Promise<Card | undefined> {
    const card = this.store?.getCard(cardId) as Card | undefined;
    if (!card || card.provider !== this.name || !card.externalId) return undefined;
    const connection = this.connection(this.organizationForCard(card));
    const remote = await this.request('GET', `/v1/issuing/cards/${encodeURIComponent(card.externalId)}`, connection.accountId);
    const balance = await this.balance(this.organizationForCard(card));
    this.store!.updateCard(card.id, { status: remote.status, last4: remote.last4, available: balance.available });
    return this.store!.getCard(card.id);
  }
  async fund(): Promise<void> {
    throw new Error('Stripe cards draw from the organization Issuing balance; fund it in Stripe');
  }
  async authorize(): Promise<AuthorizeResult> {
    return { ok: true, reason: 'reserved for Stripe real-time authorization' };
  }
  async balance(organizationId: string): Promise<PaymentBalance> {
    const connection = this.connection(organizationId);
    const value = await this.request('GET', '/v1/balance', connection.accountId);
    const currency = String((this.store!.getSettings(`organization:${organizationId}`, 'payments') as any)?.currency ?? 'usd');
    const amount = Number(value.issuing?.available?.find((entry: any) => entry.currency === currency)?.amount ?? 0);
    return { available: amount, currency,
      fundingUrl: `https://dashboard.stripe.com${connection.livemode ? '' : '/test'}/connect/accounts/${connection.accountId}/issuing/balance` };
  }
  async revoke(cardId: string): Promise<void> {
    const card = this.store?.getCard(cardId) as Card | undefined;
    if (!card?.externalId || card.provider !== this.name) throw new Error('no such Stripe card');
    const connection = this.connection(this.organizationForCard(card));
    await this.request('POST', `/v1/issuing/cards/${encodeURIComponent(card.externalId)}`,
      connection.accountId, { status: 'canceled', cancellation_reason: 'lost' }, `karmax-revoke-${card.id}`);
    this.store!.updateCard(card.id, { status: 'canceled', available: 0 });
  }
  async listCardholders(organizationId: string): Promise<any[]> {
    const connection = this.connection(organizationId);
    const value = await this.request('GET', '/v1/issuing/cardholders?limit=100', connection.accountId);
    return (value.data ?? []).map((holder: any) => ({
      id: holder.id, name: holder.name, type: holder.type, status: holder.status,
      requirements: holder.requirements,
    }));
  }
  async createCardholder(organizationId: string, input: PaymentCardholderInput): Promise<any> {
    const connection = this.connection(organizationId);
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
    const card = this.store?.getCard(cardId) as Card | undefined;
    if (!card?.externalId || card.provider !== this.name) throw new Error('no such Stripe card');
    const connection = this.connection(this.organizationForCard(card));
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
  handleWebhook(raw: Buffer, signature?: string): { status: number; body: any; stripeVersion?: string } {
    if (!this.webhookSignatureValid(raw, signature)) return { status: 400, body: { error: 'invalid Stripe signature' } };
    const event = JSON.parse(raw.toString('utf8')) as any;
    const previous = this.store!.getPaymentEvent(this.name, event.id);
    if (previous?.decision) return { status: 200, body: previous.decision, stripeVersion: STRIPE_API_VERSION };
    const connection = event.account ? this.store!.getPaymentConnectionByAccount(this.name, event.account) : undefined;
    if (!connection) return { status: 200, body: { received: true } };
    const object = event.data?.object ?? {};
    if (event.type === 'issuing_authorization.request') {
      const externalCardId = typeof object.card === 'string' ? object.card : object.card?.id;
      const card = externalCardId ? this.store!.getCardByExternalId(this.name, externalCardId) : undefined;
      const amount = Number(object.pending_request?.amount ?? object.amount ?? 0);
      const merchant = object.merchant_data?.name ?? object.merchant_data?.url;
      let decision: { approved: boolean } = { approved: false };
      if (card && card.status === 'active' && this.organizationForCard(card) === connection.organizationId
        && String(object.currency ?? card.currency ?? 'usd').toLowerCase() === String(card.currency ?? 'usd').toLowerCase()) {
        const request = this.store!.findPaymentAuthorization(card.id, amount, merchant);
        if (request && this.store!.consumePaymentAuthorization(request.id, object.id)) {
          decision = { approved: true };
          this.store!.upsertPaymentTransaction({
            organizationId: connection.organizationId, projectId: request.projectId, taskId: request.taskId,
            cardId: card.id, spendRequestId: request.id, provider: this.name, providerId: object.id,
            kind: 'authorization', status: 'approved', amount, currency: object.currency,
            merchant, raw: object, createdAt: Number(object.created ?? Date.now() / 1000) * 1000,
          });
        }
      }
      this.store!.recordPaymentEvent({ provider: this.name, eventId: event.id,
        organizationId: connection.organizationId, type: event.type, decision });
      return { status: 200, body: decision, stripeVersion: this.env.STRIPE_API_VERSION || STRIPE_API_VERSION };
    }
    this.reconcileEvent(connection.organizationId, event);
    this.store!.recordPaymentEvent({ provider: this.name, eventId: event.id,
      organizationId: connection.organizationId, type: event.type });
    return { status: 200, body: { received: true } };
  }
  private reconcileEvent(organizationId: string, event: any): void {
    const object = event.data?.object ?? {};
    const externalCardId = typeof object.card === 'string' ? object.card : object.card?.id;
    const card = externalCardId ? this.store!.getCardByExternalId(this.name, externalCardId) : undefined;
    if (card && this.organizationForCard(card) !== organizationId) return;
    if (event.type === 'issuing_card.updated' && card) {
      this.store!.updateCard(card.id, { status: object.status, last4: object.last4 });
      return;
    }
    if (event.type === 'account.application.deauthorized') {
      for (const candidate of this.store!.listOrganizationCards(organizationId)
        .filter((value) => value.provider === this.name))
        this.store!.updateCard(candidate.id, { status: 'canceled', available: 0 });
      this.store!.deletePaymentConnection(organizationId, this.name);
      return;
    }
    if (event.type.startsWith('issuing_dispute.')) {
      const transactionId = typeof object.transaction === 'string'
        ? object.transaction : object.transaction?.id;
      const transaction = transactionId
        ? this.store!.getPaymentTransactionByProviderId(this.name, transactionId)
        : undefined;
      this.store!.upsertPaymentTransaction({
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
      });
      return;
    }
    if (!card || (!event.type.startsWith('issuing_authorization.') && !event.type.startsWith('issuing_transaction.'))) return;
    const authorizationId = event.type.startsWith('issuing_authorization.')
      ? object.id : typeof object.authorization === 'string' ? object.authorization : object.authorization?.id;
    const request = authorizationId
      ? this.store!.listPaymentSpendRequests({ organizationId }).find((value) => value.providerAuthorizationId === authorizationId)
      : undefined;
    this.store!.upsertPaymentTransaction({
      organizationId, projectId: request?.projectId, taskId: request?.taskId, cardId: card.id,
      spendRequestId: request?.id, provider: this.name, providerId: object.id,
      kind: event.type.startsWith('issuing_transaction.') ? 'transaction' : 'authorization',
      status: object.status ?? (object.approved ? 'approved' : 'declined'),
      amount: Number(object.amount ?? 0), currency: object.currency ?? card.currency ?? 'usd',
      merchant: object.merchant_data?.name, raw: object,
      createdAt: Number(object.created ?? Date.now() / 1000) * 1000,
    });
    if (request && event.type.startsWith('issuing_authorization.')) {
      if (object.status === 'reversed')
        this.store!.updatePaymentSpendRequest(request.id, { status: 'reversed', reason: 'authorization reversed' });
      else if (object.approved === false)
        this.store!.updatePaymentSpendRequest(request.id, { status: 'denied', reason: 'authorization declined by Stripe' });
    }
    if (request && event.type.startsWith('issuing_transaction.')) {
      const transactionType = String(object.type ?? '').toLowerCase();
      const transactionStatus = String(object.status ?? '').toLowerCase();
      const terminalStatus = transactionType === 'refund' || transactionStatus === 'reversed'
        ? 'reversed'
        : transactionType === 'capture' || transactionStatus === 'complete'
          ? 'settled'
          : undefined;
      if (!terminalStatus) return;
      this.store!.updatePaymentSpendRequest(request.id, {
        status: terminalStatus,
      });
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
  list(ctx?: PaymentConnectionContext): ProviderInfo[] {
    return [...this.providers.values()].map((p) => p.describe(ctx));
  }
  forCard(card: Pick<Card, 'provider'>): PaymentProvider {
    return this.get(card.provider);
  }
  active(organizationId: string): PaymentProvider {
    const selected = (this.providers.values().next().value as PaymentProvider | undefined)?.name ?? 'mock';
    const name = (this.store?.getSettings(`organization:${organizationId}`, 'payments') as any)?.provider
      ?? selected;
    const provider = this.providers.get(name);
    return provider?.describe({ organizationId }).connected ? provider : this.get('mock');
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
  /** review threshold: a single spend above this needs human confirm even within allowance. */
  threshold?: number;
  /** funds available on the card (cents). */
  available: number;
  /** the card's hard cap (cents) — a single charge over this is declined by the rail. */
  hardCap: number;
  merchant?: string;
  merchantLock?: string[];
}

/**
 * Decide a spend (SPEC §7.6): hard cap → denied; over allowance or over the review
 * threshold → needs_approval; within policy but underfunded → needs_funding; else
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
    return { status: 'needs_approval', reason: `over the agent allowance (${i.spent}+${i.amount} > ${i.allowance})` };
  }
  if (i.threshold !== undefined && i.amount > i.threshold) {
    return { status: 'needs_approval', reason: `above the review threshold (${i.threshold})` };
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

  /** allowance/threshold resolve project → organization (cents). */
  private policy(projectId: string, organizationId?: string): { allowance?: number; threshold?: number } {
    const org = organizationId ?? this.store.getProject(projectId)?.organizationId ?? 'org_personal';
    const g = (this.store.getSettings(`organization:${org}`, 'payments')
      ?? (org === 'org_personal' ? this.store.getSettings('global', 'payments') : undefined)
      ?? {}) as any;
    const p = (this.store.getSettings(projectId, 'payments') ?? {}) as any;
    return { allowance: p.allowance ?? g.allowance, threshold: p.threshold ?? g.threshold };
  }

  private spent(taskId: string): number {
    return this.store.paymentSpent(taskId);
  }

  private cards(ctx: SpendCtx): Card[] {
    const visible = this.store.listCards(ctx.projectId, ctx.organizationId)
      .filter((card) => card.status !== 'canceled') as Card[];
    const scoped = (ctx.capabilities ?? []).filter((capability) => capability.startsWith('use-card:'));
    if (!scoped.length) return visible;
    return visible.filter((card) => scoped.includes('use-card:*') || scoped.includes(`use-card:${card.id}`));
  }

  private existing(ctx: SpendCtx, args: SpendArgs): any {
    return this.store.listPaymentSpendRequests({ taskId: ctx.taskId }).find((request) =>
      ['pending_approval', 'needs_funding', 'authorized', 'consumed', 'settled'].includes(request.status)
      && request.expiresAt > Date.now() && request.amount === args.amount
      && (!args.cardId || request.cardId === args.cardId)
      && (request.merchant ?? undefined) === args.merchant
      && (request.why ?? undefined) === args.why);
  }

  private result(request: any): SpendResult {
    const status: SpendStatus = request.status === 'pending_approval' ? 'needs_approval'
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
    const duplicate = this.existing(ctx, args);
    if (duplicate) return this.result(duplicate);
    const organizationId = ctx.organizationId ?? this.store.getProject(ctx.projectId)?.organizationId ?? 'org_personal';
    const visibleCards = this.cards(ctx);
    const card = args.cardId
      ? visibleCards.find((candidate) => candidate.id === args.cardId)
      : visibleCards[0];
    if (!card) {
      const reason = args.cardId
          ? 'the requested card is not available to this project'
          : 'no permitted card is configured for this project — add one or grant use-card access';
      const pending = this.store.createPaymentSpendRequest({ organizationId, projectId: ctx.projectId,
        taskId: ctx.taskId, amount: args.amount, merchant: args.merchant, why: args.why,
        status: 'needs_funding', reason, shortfall: args.amount });
      return this.result(pending);
    }
    const provider = this.provider(card);
    const refreshed = await provider.getCard(card.id) ?? card;
    const { allowance, threshold } = this.policy(ctx.projectId, ctx.organizationId);
    const decision = evaluateSpend({
      amount: args.amount,
      allowance,
      spent: this.spent(ctx.taskId),
      threshold,
      available: refreshed.available,
      // A rail without its own ceiling can only run out of funds, never breach a
      // cap — so an oversized request asks for a top-up rather than being denied.
      hardCap: provider.enforcesCardCap === false ? Number.MAX_SAFE_INTEGER
        : Math.max(0, refreshed.cap - this.store.cardPaymentSpent(refreshed.id)),
      merchant: args.merchant,
      merchantLock: refreshed.merchantLock,
    });
    if (decision.status !== 'granted') {
      const status = decision.status === 'needs_approval' ? 'pending_approval' : decision.status;
      const pending = this.store.createPaymentSpendRequest({ organizationId, projectId: ctx.projectId,
        taskId: ctx.taskId, cardId: card.id, amount: args.amount, currency: card.currency,
        merchant: args.merchant, why: args.why, status, reason: decision.reason,
        shortfall: decision.shortfall });
      let fundingUrl: string | undefined;
      if (decision.status === 'needs_funding') fundingUrl = (await provider.balance(organizationId)).fundingUrl;
      return { ...this.result(pending), fundingUrl };
    }
    const pending = this.store.createPaymentSpendRequest({ organizationId, projectId: ctx.projectId,
      taskId: ctx.taskId, cardId: card.id, amount: args.amount, currency: card.currency,
      merchant: args.merchant, why: args.why,
      status: provider.authorizationMode === 'webhook' ? 'authorized' : 'authorizing' });
    if (provider.authorizationMode === 'webhook') return this.result(pending);
    const auth = await provider.authorize(card.id, args.amount, args.merchant);
    if (!auth.ok) {
      return this.result(this.store.updatePaymentSpendRequest(pending.id, {
        status: 'needs_funding', reason: auth.reason ?? 'authorization declined', shortfall: args.amount,
      }));
    }
    this.store.upsertPaymentTransaction({ organizationId, projectId: ctx.projectId, taskId: ctx.taskId,
      cardId: card.id, spendRequestId: pending.id, provider: provider.name,
      providerId: auth.transactionId!, kind: 'transaction', status: 'settled',
      amount: args.amount, currency: card.currency, merchant: args.merchant });
    return this.result(this.store.updatePaymentSpendRequest(pending.id, {
      status: 'settled', providerAuthorizationId: auth.transactionId,
    }));
  }

  async approve(requestId: string, resolvedBy: string): Promise<SpendResult> {
    const request = this.store.getPaymentSpendRequest(requestId);
    if (!request) return { status: 'denied', reason: 'spend request not found' };
    if (!['pending_approval', 'needs_funding'].includes(request.status)) return this.result(request);
    const card = request.cardId
      ? this.store.getCard(request.cardId) as Card | undefined
      : this.cards({
        projectId: request.projectId,
        taskId: request.taskId,
        organizationId: request.organizationId,
      })[0];
    if (!card) return this.result(this.store.updatePaymentSpendRequest(request.id,
      { status: 'denied', reason: 'card no longer exists', resolvedBy }));
    if (!request.cardId) this.store.setPaymentSpendRequestCard(request.id, card.id);
    const provider = this.provider(card);
    const refreshed = await provider.getCard(card.id) ?? card;
    if (refreshed.status === 'canceled' || refreshed.status === 'inactive')
      return this.result(this.store.updatePaymentSpendRequest(request.id,
        { status: 'denied', reason: 'card is not active', resolvedBy }));
    if (refreshed.available < request.amount) {
      return this.result(this.store.updatePaymentSpendRequest(request.id, {
        status: 'needs_funding', reason: 'insufficient funds on the card',
        shortfall: request.amount - refreshed.available, resolvedBy,
      }));
    }
    if (provider.authorizationMode === 'webhook') {
      return this.result(this.store.updatePaymentSpendRequest(request.id,
        { status: 'authorized', reason: 'approved', shortfall: 0, resolvedBy, expiresAt: Date.now() + 30 * 60_000 }));
    }
    const auth = await provider.authorize(card.id, request.amount, request.merchant ?? undefined);
    if (!auth.ok) return this.result(this.store.updatePaymentSpendRequest(request.id,
      { status: 'needs_funding', reason: auth.reason, shortfall: request.amount, resolvedBy }));
    this.store.upsertPaymentTransaction({ organizationId: request.organizationId, projectId: request.projectId,
      taskId: request.taskId, cardId: card.id, spendRequestId: request.id, provider: provider.name,
      providerId: auth.transactionId!, kind: 'transaction', status: 'settled',
      amount: request.amount, currency: request.currency, merchant: request.merchant });
    return this.result(this.store.updatePaymentSpendRequest(request.id,
      { status: 'settled', providerAuthorizationId: auth.transactionId, reason: 'approved', resolvedBy }));
  }

  deny(requestId: string, resolvedBy: string): SpendResult {
    const request = this.store.getPaymentSpendRequest(requestId);
    if (!request) return { status: 'denied', reason: 'spend request not found' };
    return this.result(this.store.updatePaymentSpendRequest(request.id,
      { status: 'denied', reason: 'denied by reviewer', resolvedBy }));
  }

  /** Back-compatible test/helper entry point. */
  async settleApproved(ctx: SpendCtx, args: SpendArgs): Promise<SpendResult> {
    const existing = this.store.listPaymentSpendRequests({ taskId: ctx.taskId })
      .find((request) => request.amount === args.amount && (!args.cardId || request.cardId === args.cardId)
        && ['pending_approval', 'needs_funding'].includes(request.status));
    if (existing) return this.approve(existing.id, 'system:settle');
    const first = await this.request(ctx, args);
    return first.requestId ? this.approve(first.requestId, 'system:settle') : first;
  }
}
