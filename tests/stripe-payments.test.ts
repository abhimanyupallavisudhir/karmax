import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BudgetService, PaymentRegistry, StripeIssuingProvider } from '../src/autonomy/payments.js';
import { Store } from '../src/store/db.js';

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

describe('Stripe Issuing organization rail', () => {
  let store: Store;
  let fetcher: ReturnType<typeof vi.fn>;
  let stripe: StripeIssuingProvider;
  let organizationId: string;
  let projectId: string;
  const env = {
    STRIPE_CLIENT_ID: 'ca_karmax',
    STRIPE_SECRET_KEY: 'sk_test_platform',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
  };

  beforeEach(async () => {
    store = (await Store.create(':memory:'));
    organizationId = (await store.createOrganization({ name: 'Tenant A' })).id;
    projectId = (await store.createProject('Payments', {}, organizationId)).id;
    (await store.setSettings(`organization:${organizationId}`, 'payments', { budget: null }));
    fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://connect.stripe.com/oauth/token')
        return json({ stripe_user_id: 'acct_tenant_a', livemode: false });
      if (url === 'https://connect.stripe.com/oauth/deauthorize')
        return json({ stripe_user_id: 'acct_tenant_a' });
      if (url === 'https://api.stripe.com/v1/account')
        return json({ country: 'US', capabilities: { card_issuing: 'active' },
          business_profile: { name: 'Tenant A LLC' } });
      if (url === 'https://api.stripe.com/v1/balance')
        return json({ issuing: { available: [{ currency: 'usd', amount: 25_000 }] } });
      if (url === 'https://api.stripe.com/v1/issuing/cardholders?limit=100')
        return json({ data: [{ id: 'ich_tenant_a', name: 'Tenant A buyer', type: 'individual', status: 'active' }] });
      if (url === 'https://api.stripe.com/v1/issuing/cardholders' && init?.method === 'POST')
        return json({ id: 'ich_tenant_a', name: 'Tenant A buyer', type: 'individual', status: 'active' });
      if (url === 'https://api.stripe.com/v1/issuing/cards' && init?.method === 'POST')
        return json({ id: 'ic_tenant_a', status: 'active', last4: '4242' });
      if (url === 'https://api.stripe.com/v1/issuing/cards/ic_tenant_a')
        return json({ id: 'ic_tenant_a', status: 'active', last4: '4242' });
      if (url === 'https://api.stripe.com/v1/issuing/cards/ic_tenant_a?expand[]=number&expand[]=cvc')
        return json({ id: 'ic_tenant_a', number: '4242424242424242', cvc: '123', exp_month: 12, exp_year: 2030 });
      throw new Error(`unexpected Stripe request ${init?.method ?? 'GET'} ${url}`);
    });
    stripe = new StripeIssuingProvider(store, fetcher as any, env);
  });

  async function connect() {
    const started = await stripe.connect({
      organizationId,
      userId: 'user_a',
      redirectUri: 'https://karmax.example/api/payments/stripe/callback',
    });
    expect(started.status).toBe('awaiting_oauth');
    const state = new URL(started.url!).searchParams.get('state')!;
    return stripe.completeOAuth(state, 'ac_test', 'user_a');
  }

  it('rejects a callback from a different user without consuming state (AU-2)', async () => {
    const started = await stripe.connect({ organizationId, userId: 'user_a', redirectUri: 'https://karmax.example/callback' });
    const state = new URL(started.url!).searchParams.get('state')!;
    await expect(stripe.completeOAuth(state, 'code', 'user_b')).rejects.toThrow(/state/);
    expect(fetcher).not.toHaveBeenCalled();
    await expect(stripe.completeOAuth(state, 'code', 'user_a')).resolves.toMatchObject({ organizationId });
  });

  it('refuses linking the same Stripe account to another tenant (AU-2)', async () => {
    await connect();
    const other = await store.createOrganization({ name: 'Other' });
    await expect(store.upsertPaymentConnection({ organizationId: other.id, provider: 'stripe', accountId: 'acct_tenant_a' })).rejects.toThrow();
  });

  function signed(event: unknown) {
    const raw = Buffer.from(JSON.stringify(event));
    const timestamp = Math.floor(Date.now() / 1000);
    const digest = crypto.createHmac('sha256', env.STRIPE_WEBHOOK_SECRET)
      .update(`${timestamp}.${raw.toString('utf8')}`).digest('hex');
    return { raw, signature: `t=${timestamp},v1=${digest}` };
  }

  it('accepts installation-admin setup from encrypted secret storage without environment variables', async () => {
    const secrets = new Map<string, string>();
    const broker = {
      hasHandle: (handle: string) => secrets.has(handle),
      registerHandle: (handle: string, value: string) => secrets.set(handle, value),
      resolve: (handle: string) => secrets.get(handle),
    };
    const managed = new StripeIssuingProvider(store, fetcher as any, {}, broker as any);
    expect((await managed.platformStatus())).toMatchObject({
      configured: false, secretKeyConfigured: false, webhookConfigured: false, source: 'none',
    });
    expect((await managed.configurePlatform({
      clientId: 'ca_ui_managed',
      secretKey: 'sk_test_ui_managed',
      webhookSecret: 'whsec_ui_managed',
    }))).toMatchObject({
      configured: true, clientId: 'ca_ui_managed', secretKeyConfigured: true,
      webhookConfigured: true, source: 'ui',
    });
    expect(JSON.stringify((await store.exportOrganization(organizationId)))).not.toContain('sk_test_ui_managed');

    const started = await managed.connect({
      organizationId,
      userId: 'user_a',
      redirectUri: 'https://karmax.example/api/payments/stripe/callback',
    });
    expect(new URL(started.url!).searchParams.get('client_id')).toBe('ca_ui_managed');
    const state = new URL(started.url!).searchParams.get('state')!;
    await managed.completeOAuth(state, 'ac_test', 'user_a');
    const oauth = fetcher.mock.calls.find(([url]) => url === 'https://connect.stripe.com/oauth/token')!;
    expect(new URLSearchParams(String(oauth[1].body)).get('client_secret')).toBe('sk_test_ui_managed');

    const raw = Buffer.from('{"id":"event"}');
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = crypto.createHmac('sha256', 'whsec_ui_managed')
      .update(`${timestamp}.${raw.toString('utf8')}`).digest('hex');
    expect(managed.webhookSignatureValid(raw, `t=${timestamp},v1=${signature}`)).toBe(true);
  });

  it('validates UI-managed Stripe platform credentials without replacing retained secrets', async () => {
    const secrets = new Map<string, string>();
    const broker = {
      hasHandle: (handle: string) => secrets.has(handle),
      registerHandle: (handle: string, value: string) => secrets.set(handle, value),
      resolve: (handle: string) => secrets.get(handle),
    };
    const managed = new StripeIssuingProvider(store, fetcher as any, {}, broker as any);
    await expect((async () => (await managed.configurePlatform({ clientId: 'not-a-client-id', secretKey: 'sk_test_ok' })))()).rejects.toThrow(/client ID/);
    (await managed.configurePlatform({ clientId: 'ca_first', secretKey: 'sk_test_retained' }));
    (await managed.configurePlatform({ clientId: 'ca_updated' }));
    expect((await managed.platformStatus())).toMatchObject({
      configured: true, clientId: 'ca_updated', secretKeyConfigured: true,
    });
    expect([...secrets.values()]).toContain('sk_test_retained');
  });

  it('stores a separate connected account and balance for the organization', async () => {
    await connect();
    expect((await store.getPaymentConnection(organizationId, 'stripe'))).toMatchObject({
      accountId: 'acct_tenant_a',
      status: 'ready',
    });
    expect((await stripe.describe({ organizationId })).connected).toBe(true);
    const other = (await store.createOrganization({ name: 'Tenant B' }));
    expect((await stripe.describe({ organizationId: other.id })).connected).toBe(false);
    expect(await stripe.balance(organizationId)).toMatchObject({ available: 25_000, currency: 'usd' });
    expect(fetcher.mock.calls.find(([url]) => url === 'https://api.stripe.com/v1/balance')?.[1]?.headers)
      .toMatchObject({ 'stripe-account': 'acct_tenant_a' });
  });

  it('creates a tenant cardholder and virtual card with a provider-side all-time cap', async () => {
    await connect();
    expect(await stripe.listCardholders(organizationId)).toHaveLength(1);
    await expect(stripe.createCardholder(organizationId, {
      type: 'individual',
      name: 'Incomplete buyer',
      address: { line1: '1 Main', city: 'SF', postalCode: '94105', country: 'US' },
    })).rejects.toThrow(/first name, last name, and date of birth/);
    await stripe.createCardholder(organizationId, {
      type: 'individual',
      name: 'Tenant A buyer',
      firstName: 'Tenant',
      lastName: 'Buyer',
      dob: { day: 1, month: 2, year: 1990 },
      address: { line1: '1 Main', city: 'SF', state: 'CA', postalCode: '94105', country: 'US' },
    });
    const card = await stripe.provisionCard({
      scope: 'project',
      scopeId: projectId,
      organizationId,
      label: 'Agent card',
      cap: 12_345,
      cardholderId: 'ich_tenant_a',
    });
    expect(card).toMatchObject({ provider: 'stripe', externalId: 'ic_tenant_a', last4: '4242', available: 25_000 });
    const create = fetcher.mock.calls.find(([url, init]) =>
      url === 'https://api.stripe.com/v1/issuing/cards' && init?.method === 'POST')!;
    const form = new URLSearchParams(String(create[1].body));
    expect(form.get('spending_controls[spending_limits][0][amount]')).toBe('12345');
    expect(form.get('spending_controls[spending_limits][0][interval]')).toBe('all_time');
    expect((create[1].headers as any)['stripe-account']).toBe('acct_tenant_a');
    expect(await stripe.retrieveCardDetails(card.id)).toEqual({
      number: '4242424242424242', cvc: '123', expMonth: 12, expYear: 2030,
    });
    expect(JSON.stringify((await store.getCard(card.id)))).not.toContain('4242424242424242');
    expect(JSON.stringify((await store.exportOrganization(organizationId)))).not.toContain('4242424242424242');
  });

  it('reserves a spend, approves only the matching real-time authorization, and reconciles capture', async () => {
    await connect();
    const card = await stripe.provisionCard({
      scope: 'project', scopeId: projectId, organizationId, label: 'Agent card',
      cap: 12_345, cardholderId: 'ich_tenant_a', merchantLock: ['shop.example'],
    });
    const registry = new PaymentRegistry(store);
    registry.register(stripe);
    const budget = new BudgetService(store, registry);
    const spend = await budget.request(
      { organizationId, projectId, taskId: 'task_a' },
      { amount: 2_500, merchant: 'shop.example', why: 'test purchase', cardId: card.id },
    );
    expect(spend).toMatchObject({ status: 'granted', cardId: card.id });
    expect(spend.requestId).toBeTruthy();

    const authorization = signed({
      id: 'evt_auth', account: 'acct_tenant_a', type: 'issuing_authorization.request',
      data: { object: {
        id: 'iauth_1', card: 'ic_tenant_a', pending_request: { amount: 2_500 },
        currency: 'usd', merchant_data: { name: 'shop.example' }, created: 1_700_000_000,
      } },
    });
    expect((await stripe.handleWebhook(authorization.raw, authorization.signature))).toMatchObject({
      status: 200, body: { approved: true },
    });
    expect((await stripe.handleWebhook(authorization.raw, authorization.signature)).body).toEqual({ approved: true });
    expect((await store.getPaymentSpendRequest(spend.requestId!)).status).toBe('consumed');

    const capture = signed({
      id: 'evt_capture', account: 'acct_tenant_a', type: 'issuing_transaction.created',
      data: { object: {
        id: 'itxn_1', type: 'capture', card: 'ic_tenant_a', authorization: 'iauth_1',
        amount: 2_500, currency: 'usd', merchant_data: { name: 'shop.example' }, created: 1_700_000_010,
      } },
    });
    expect((await stripe.handleWebhook(capture.raw, capture.signature)).status).toBe(200);
    expect((await store.getPaymentSpendRequest(spend.requestId!)).status).toBe('settled');
    expect((await store.listPaymentTransactions(organizationId)).map((value) => value.kind).sort())
      .toEqual(['authorization', 'transaction']);
  });

  /**
   * A reservation is an upper bound — the agent asks for "up to $100" because the
   * price is not known until checkout. What must count against a virtual card's
   * cap is the money the rail actually moved, which is why `findPaymentAuthorization`
   * deliberately matches an authorization *smaller* than the reservation. Counting
   * the reservation instead burns the card's ceiling (and the task's allowance) for
   * money nobody ever spent, permanently.
   */
  describe('the cap counts what the rail charged, not what was reserved', () => {
    async function reserved(amount = 10_000) {
      await connect();
      const card = await stripe.provisionCard({
        scope: 'project', scopeId: projectId, organizationId, label: 'Agent card',
        cap: 12_345, cardholderId: 'ich_tenant_a',
      });
      const registry = new PaymentRegistry(store);
      registry.register(stripe);
      const budget = new BudgetService(store, registry);
      const spend = await budget.request({ organizationId, projectId, taskId: 'task_a' },
        { amount, merchant: 'shop.example', why: 'up to $100', cardId: card.id });
      expect(spend.status).toBe('granted');
      return { card, budget, spend };
    }
    const authorize = (amount: number) => signed({
      id: 'evt_auth', account: 'acct_tenant_a', type: 'issuing_authorization.request',
      data: { object: { id: 'iauth_1', card: 'ic_tenant_a', pending_request: { amount },
        currency: 'usd', merchant_data: { name: 'shop.example' } } },
    });
    // Stripe signs an issuing transaction from the cardholder's side: a capture is
    // negative (money out), a refund positive.
    const settle = (id: string, type: 'capture' | 'refund', amount: number) => signed({
      id: `evt_${id}`, account: 'acct_tenant_a', type: 'issuing_transaction.created',
      data: { object: { id, type, card: 'ic_tenant_a', authorization: 'iauth_1',
        amount, currency: 'usd', merchant_data: { name: 'shop.example' } } },
    });

    it('reconciles the reservation down to the authorized and captured amount', async () => {
      const { card, budget, spend } = await reserved();
      const auth = authorize(4_000);
      expect((await stripe.handleWebhook(auth.raw, auth.signature)).body).toEqual({ approved: true });
      expect((await store.cardPaymentSpent(card.id))).toBe(4_000);
      expect((await store.paymentSpent('task_a'))).toBe(4_000);

      const capture = settle('itxn_1', 'capture', -4_000);
      expect((await stripe.handleWebhook(capture.raw, capture.signature)).status).toBe(200);
      expect((await store.getPaymentSpendRequest(spend.requestId!))).toMatchObject({ status: 'settled', amount: 4_000 });
      // The 60 dollars the merchant never took are spendable again.
      expect((await budget.request({ organizationId, projectId, taskId: 'task_b' },
        { amount: 8_000, cardId: card.id, why: 'second' })).status).toBe('granted');
    });

    it('frees only the refunded part of a settled spend', async () => {
      const { card, spend } = await reserved(4_000);
      const auth = authorize(4_000);
      (await stripe.handleWebhook(auth.raw, auth.signature));
      const capture = settle('itxn_1', 'capture', -4_000);
      (await stripe.handleWebhook(capture.raw, capture.signature));
      const partial = settle('itxn_2', 'refund', 1_500);
      (await stripe.handleWebhook(partial.raw, partial.signature));
      expect((await store.getPaymentSpendRequest(spend.requestId!))).toMatchObject({ status: 'settled', amount: 2_500 });
      expect((await store.cardPaymentSpent(card.id))).toBe(2_500);
      const rest = settle('itxn_3', 'refund', 2_500);
      (await stripe.handleWebhook(rest.raw, rest.signature));
      expect((await store.getPaymentSpendRequest(spend.requestId!)).status).toBe('reversed');
      expect((await store.cardPaymentSpent(card.id))).toBe(0);
    });

    it('re-counts the cap when a queued spend is approved on the webhook rail', async () => {
      await connect();
      const card = await stripe.provisionCard({
        scope: 'project', scopeId: projectId, organizationId, label: 'Agent card',
        cap: 12_345, cardholderId: 'ich_tenant_a',
      });
      const registry = new PaymentRegistry(store);
      registry.register(stripe);
      const budget = new BudgetService(store, registry);
      (await store.setSettings(`organization:${organizationId}`, 'payments', { provider: 'stripe', budget: 1_000 }));
      const ctx = { organizationId, projectId, taskId: 'task_gate' };
      const first = await budget.request(ctx, { amount: 8_000, cardId: card.id, why: 'first' });
      const second = await budget.request(ctx, { amount: 8_000, cardId: card.id, why: 'second' });
      expect([first.status, second.status]).toEqual(['needs_approval', 'needs_approval']);
      expect((await budget.approve(first.requestId!, 'user:a')).status).toBe('granted');
      // The webhook rail never calls `authorize()`, so approval was the only place
      // this could be caught — and it was not looking. 16 000 on a 12 345 card.
      expect(await budget.approve(second.requestId!, 'user:a'))
        .toMatchObject({ status: 'denied', reason: 'exceeds the card hard cap' });
      expect((await store.cardPaymentSpent(card.id))).toBe(8_000);
    });
  });

  it('rejects unsigned webhooks and authorizations without a matching reservation', async () => {
    await connect();
    await stripe.provisionCard({
      scope: 'project', scopeId: projectId, organizationId, label: 'Agent card',
      cap: 12_345, cardholderId: 'ich_tenant_a',
    });
    const event = signed({
      id: 'evt_unreserved', account: 'acct_tenant_a', type: 'issuing_authorization.request',
      data: { object: { id: 'iauth_none', card: 'ic_tenant_a', pending_request: { amount: 99 },
        currency: 'usd', merchant_data: { name: 'shop.example' } } },
    });
    expect((await stripe.handleWebhook(event.raw, 'bad')).status).toBe(400);
    expect((await stripe.handleWebhook(event.raw, event.signature)).body).toEqual({ approved: false });
  });

  it('revokes project cards before disconnecting the organization account', async () => {
    await connect();
    const card = await stripe.provisionCard({
      scope: 'project', scopeId: projectId, organizationId, label: 'Project card',
      cap: 12_345, cardholderId: 'ich_tenant_a',
    });
    await stripe.disconnect(organizationId);
    expect((await store.getCard(card.id))).toMatchObject({ status: 'canceled', available: 0 });
    expect((await store.getPaymentConnection(organizationId, 'stripe'))).toBeUndefined();
    expect(fetcher.mock.calls.some(([url, init]) =>
      url === 'https://api.stripe.com/v1/issuing/cards/ic_tenant_a'
      && init?.method === 'POST')).toBe(true);
    expect(fetcher.mock.calls.some(([url]) => url === 'https://connect.stripe.com/oauth/deauthorize')).toBe(true);
  });
});
