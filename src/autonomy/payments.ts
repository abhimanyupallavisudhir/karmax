import { Store } from '../store/db.js';
import { newId } from '../util/id.js';

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
  createdAt: number;
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
  /** 'local' = no external account (mock); 'oauth' = connect a provider account. */
  kind: 'local' | 'oauth';
  connected: boolean;
  help?: string;
}
export interface ConnectResult {
  status: 'connected' | 'awaiting_oauth' | 'unavailable';
  /** OAuth URL for the user to complete (kind 'oauth'). karmax never sees card data. */
  url?: string;
  detail?: string;
}

export interface PaymentProvider {
  readonly name: string;
  provisionCard(spec: { scope: 'project' | 'organization' | 'global'; scopeId?: string; label: string; cap: number; merchantLock?: string[] }): Promise<Card>;
  getCard(cardId: string): Promise<Card | undefined>;
  fund(cardId: string, amount: number): Promise<void>;
  /** Attempt a charge; the rail enforces the hard cap + merchant lock + funds. */
  authorize(cardId: string, amount: number, merchant?: string): Promise<AuthorizeResult>;
  /** Provider metadata for the connect surface. */
  describe(): ProviderInfo;
  /** Start (or report) connecting funding to this provider. */
  connect(): Promise<ConnectResult>;
}

/** Mock rail: card state lives in the karmax store. Real rails (Stripe) keep it provider-side. */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';
  constructor(private store: Store) {}

  async provisionCard(spec: { scope: 'project' | 'organization' | 'global'; scopeId?: string; label: string; cap: number; merchantLock?: string[] }): Promise<Card> {
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
    const c = this.store.getCard(cardId);
    if (c) this.store.updateCard(cardId, { available: c.available + amount });
  }
  async authorize(cardId: string, amount: number, merchant?: string): Promise<AuthorizeResult> {
    const c = this.store.getCard(cardId);
    if (!c) return { ok: false, reason: 'no such card' };
    if (c.merchantLock?.length && merchant && !c.merchantLock.includes(merchant)) return { ok: false, reason: 'merchant not allowed' };
    if (amount > c.cap) return { ok: false, reason: 'exceeds card cap' };
    if (amount > c.available) return { ok: false, reason: 'insufficient funds' };
    this.store.updateCard(cardId, { available: c.available - amount });
    return { ok: true, transactionId: newId('txn') };
  }
  describe(): ProviderInfo {
    return { name: this.name, label: 'Local (no external account)', kind: 'local', connected: true, help: 'Cards are local test funds — fully usable, no real money. Great for trying karmax.' };
  }
  async connect(): Promise<ConnectResult> {
    return { status: 'connected', detail: 'Local provider needs no connection — add and fund cards below.' };
  }
}

/**
 * Stripe Issuing rail (SPEC §7.6, layer c-2). You connect your Stripe account via
 * OAuth — Stripe holds the card data / PCI; karmax stores only the account handle
 * and references the Stripe-issued virtual card ids. Card provisioning + auth-time
 * decline are enforced by Stripe. The rail itself (API calls) is the c-2 work; this
 * implements the *connect* surface so the model is real and pluggable now.
 */
export class StripeIssuingProvider implements PaymentProvider {
  readonly name = 'stripe';
  private notConfigured(): never {
    throw new Error('Stripe Issuing is not configured yet — set STRIPE_SECRET_KEY and connect your account first.');
  }
  describe(): ProviderInfo {
    const connected = !!process.env.STRIPE_SECRET_KEY;
    return {
      name: this.name,
      label: 'Stripe Issuing',
      kind: 'oauth',
      connected,
      help: connected
        ? 'Connected. You authorize karmax to your Stripe account; Stripe issues the cards and holds the card data — karmax never sees the card number.'
        : 'Connect your Stripe account with one click (OAuth) — you authorize, karmax stores only the account handle. Enabled by the karmax operator; you never enter keys or card numbers.',
    };
  }
  async connect(): Promise<ConnectResult> {
    // STRIPE_CLIENT_ID is the *platform operator's* Stripe Connect app id — set once
    // for the whole deployment, NOT per user. Each user just authorizes via OAuth and
    // their connected-account id is stored per-account (multi-tenant safe).
    const clientId = process.env.STRIPE_CLIENT_ID;
    if (!clientId) {
      return { status: 'unavailable', detail: 'Stripe Issuing is not enabled on this karmax deployment yet — the operator configures the platform Stripe Connect app once. Until then, use Local funds.' };
    }
    // Standard Stripe Connect OAuth — the user authorizes; karmax never types creds.
    const url = `https://connect.stripe.com/oauth/authorize?response_type=code&scope=read_write&client_id=${encodeURIComponent(clientId)}`;
    return { status: 'awaiting_oauth', url, detail: 'Authorize karmax in Stripe; you complete it — karmax never sees your Stripe password or card numbers.' };
  }
  // Card operations require the live rail (c-2).
  async provisionCard(): Promise<Card> { this.notConfigured(); }
  async getCard(): Promise<Card | undefined> { return undefined; }
  async fund(): Promise<void> { this.notConfigured(); }
  async authorize(): Promise<AuthorizeResult> { return { ok: false, reason: 'Stripe rail not configured' }; }
}

export class PaymentRegistry {
  private providers = new Map<string, PaymentProvider>();
  register(p: PaymentProvider) {
    this.providers.set(p.name, p);
  }
  get(name = 'mock'): PaymentProvider {
    const p = this.providers.get(name);
    if (!p) throw new Error(`no payment provider "${name}"`);
    return p;
  }
  list(): ProviderInfo[] {
    return [...this.providers.values()].map((p) => p.describe());
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
  if (i.merchantLock?.length && i.merchant && !i.merchantLock.includes(i.merchant)) {
    return { status: 'denied', reason: `merchant "${i.merchant}" not allowed on this card` };
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
}

export class BudgetService {
  constructor(
    private store: Store,
    private provider: PaymentProvider,
  ) {}

  /** allowance/threshold resolve project → global (cents). */
  private policy(projectId: string): { allowance?: number; threshold?: number } {
    const g = (this.store.getSettings('global', 'payments') ?? {}) as any;
    const p = (this.store.getSettings(projectId, 'payments') ?? {}) as any;
    return { allowance: p.allowance ?? g.allowance, threshold: p.threshold ?? g.threshold };
  }

  private spent(taskId: string): number {
    return Number(this.store.kvGet(`spent:${taskId}`) ?? 0);
  }

  /** Decide a spend; on `granted`, authorize the charge and record it. */
  async request(ctx: SpendCtx, args: SpendArgs): Promise<SpendResult> {
    const card = args.cardId ? await this.provider.getCard(args.cardId) : this.store.listCards(ctx.projectId, ctx.organizationId)[0];
    if (!card) {
      return { status: 'needs_funding', reason: 'no card is configured for this project — add and fund one', shortfall: args.amount };
    }
    const { allowance, threshold } = this.policy(ctx.projectId);
    const decision = evaluateSpend({
      amount: args.amount,
      allowance,
      spent: this.spent(ctx.taskId),
      threshold,
      available: card.available,
      hardCap: card.cap,
      merchant: args.merchant,
      merchantLock: card.merchantLock,
    });
    if (decision.status !== 'granted') return { ...decision, cardId: card.id };
    const auth = await this.provider.authorize(card.id, args.amount, args.merchant);
    if (!auth.ok) {
      // rail declined despite policy ok (e.g. funds raced) → surface as funding
      return { status: 'needs_funding', reason: auth.reason ?? 'authorization declined', shortfall: args.amount, cardId: card.id };
    }
    this.store.kvSet(`spent:${ctx.taskId}`, String(this.spent(ctx.taskId) + args.amount));
    return { status: 'granted', cardId: card.id, transactionId: auth.transactionId };
  }

  /** After a human approves/funds, charge the held request (used by the review gate). */
  async settleApproved(ctx: SpendCtx, args: SpendArgs): Promise<SpendResult> {
    const card = args.cardId ? await this.provider.getCard(args.cardId) : this.store.listCards(ctx.projectId, ctx.organizationId)[0];
    if (!card) return { status: 'denied', reason: 'no card' };
    const auth = await this.provider.authorize(card.id, args.amount, args.merchant);
    if (!auth.ok) return { status: 'needs_funding', reason: auth.reason, shortfall: args.amount, cardId: card.id };
    this.store.kvSet(`spent:${ctx.taskId}`, String(this.spent(ctx.taskId) + args.amount));
    return { status: 'granted', cardId: card.id, transactionId: auth.transactionId };
  }
}
