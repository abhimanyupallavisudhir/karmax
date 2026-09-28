import { describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { BillingRequestRejected, PaddleSubscriptionProvider } from '../src/billing/paddle.js';
import { FakeSubscriptionProvider, SubscriptionBillingService } from '../src/billing/subscriptions.js';
import { HOSTED_PLANS } from '../src/domain/entitlements.js';
import { Store } from '../src/store/db.js';

const config = { environment: 'sandbox' as const, apiKey: 'pdl_sdbx_apikey_test',
  webhookSecret: 'pdl_ntfset_test', clientToken: 'test_token',
  individualPriceId: 'pri_individual', teamBasePriceId: 'pri_team', teamSeatPriceId: 'pri_seat' };
const payload = (id: string, status = 'active', time = '2026-09-24T12:00:00.123Z') => ({
  event_id: id, event_type: status === 'canceled' ? 'subscription.canceled' : 'subscription.created', occurred_at: time,
  data: { id: 'sub_test', customer_id: 'ctm_shared', transaction_id: 'txn_test', status,
    current_billing_period: { ends_at: '2026-10-24T12:00:00Z' }, scheduled_change: null,
    items: [{ price: { id: config.teamBasePriceId, product_id: 'pro_team' }, quantity: 1 },
      { price: { id: config.teamSeatPriceId, product_id: 'pro_team' }, quantity: 2 }] },
});
const signed = (value: unknown, secret = config.webhookSecret) => {
  const raw = Buffer.from(JSON.stringify(value));
  const timestamp = Math.floor(Date.now() / 1000);
  return { raw, signature: `ts=${timestamp};h1=${crypto.createHmac('sha256', secret).update(`${timestamp}:`).update(raw).digest('hex')}` };
};

describe('Paddle subscription billing', () => {
  it('keeps legacy webhook routing on Stripe when new checkouts select Paddle', async () => {
    const store = await Store.create(':memory:', { hosted: true });
    try {
      const stripe = new FakeSubscriptionProvider();
      Object.defineProperty(stripe, 'name', { value: 'stripe-billing' });
      const paddle = new PaddleSubscriptionProvider(() => config);
      const resolve = vi.fn(async (name?: string) => name === 'stripe-billing' ? stripe : paddle);
      const billing = new SubscriptionBillingService(store, resolve, true);
      await billing.handleWebhook(Buffer.from(JSON.stringify({ id: 'evt_legacy', type: 'ignored', created: 100, data: { object: {} } })));
      expect(resolve).toHaveBeenLastCalledWith('stripe-billing');
      const event = signed({ event_id: 'evt_paddle', event_type: 'transaction.updated', occurred_at: new Date().toISOString(), data: {} });
      await billing.handleWebhook(event.raw, event.signature, 'paddle-billing');
      expect(resolve).toHaveBeenLastCalledWith('paddle-billing');
    } finally { await store.close(); }
  });

  it('creates server-priced transactions without inventing customer email addresses', async () => {
    const fetcher = vi.fn(async () => Response.json({ data: { id: 'txn_test' } }));
    const provider = new PaddleSubscriptionProvider(() => config, fetcher);
    const result = await provider.createCheckout({ organizationId: 'org_test', customerId: '', plan: 'team', seats: 3,
      successUrl: 'https://example.test/?checkout=success', cancelUrl: 'https://example.test/', idempotencyKey: 'checkout-test' });
    expect(result).toEqual({ id: 'txn_test', url: 'https://example.test/billing/checkout?success=https%3A%2F%2Fexample.test%2F%3Fcheckout%3Dsuccess&_ptxn=txn_test' });
    expect(fetcher).toHaveBeenCalledWith('https://sandbox-api.paddle.com/transactions', expect.objectContaining({ method: 'POST' }));
    const request = JSON.parse((fetcher.mock.calls[0] as any)[1].body);
    expect(request.items).toEqual([{ price_id: 'pri_team', quantity: 1 }, { price_id: 'pri_seat', quantity: 2 }]);
    expect(request.customer_id).toBeUndefined();
    expect((fetcher.mock.calls[0] as any)[1].headers.Authorization).toBe(`Bearer ${config.apiKey}`);
  });

  it('verifies raw-body signatures, including secret rotation, and preserves event precision', async () => {
    const provider = new PaddleSubscriptionProvider(() => config);
    const event = signed(payload('evt_test'));
    const normalized = await provider.verifyWebhook(event.raw, `${event.signature};h1=${'0'.repeat(64)}`);
    expect(normalized).toMatchObject({ id: 'evt_test', checkoutId: 'txn_test', created: Date.parse('2026-09-24T12:00:00.123Z') / 1000,
      data: { object: { status: 'active', customer: 'ctm_shared', items: { data: [
        { id: 'pri_team', price: { id: 'pri_team', product: 'pro_team' }, quantity: 1 },
        { id: 'pri_seat', price: { id: 'pri_seat', product: 'pro_team' }, quantity: 2 },
      ] } } } });
    await expect(provider.verifyWebhook(Buffer.from(event.raw.toString().replace('active', 'paused')), event.signature)).rejects.toThrow(/signature/);
    await expect(provider.verifyWebhook(event.raw, event.signature.replace(/ts=\d+/, 'ts=1'))).rejects.toThrow(/expired|signature/);
    await expect(provider.verifyWebhook(event.raw, undefined)).rejects.toThrow(/signature/);
  });

  it('replaces the whole item list and removes the extra-seat item at the included count', async () => {
    const fetcher = vi.fn(async (_url: any, init: any) => Response.json({ data: init.method === 'GET'
      ? { id: 'sub_test', items: [{ price: { id: 'pri_team' }, quantity: 1 }, { price: { id: 'pri_seat' }, quantity: 2 }] }
      : { id: 'sub_test' } }));
    const provider = new PaddleSubscriptionProvider(() => config, fetcher);
    await provider.updateSeats({ subscriptionId: 'sub_test', seats: 1, idempotencyKey: 'seats-test' });
    const request = JSON.parse(fetcher.mock.calls.find(([, init]) => init.method === 'PATCH')![1].body);
    expect(request).toEqual({ items: [{ price_id: 'pri_team', quantity: 1 }], proration_billing_mode: 'prorated_next_billing_period' });
  });

  it('binds only server-created transactions, handles replay and cancellation, and never trusts org metadata', async () => {
    const store = await Store.create(':memory:', { hosted: true });
    try {
      const org = await store.createOrganization({ name: 'Paddle team', ownerUserId: 'owner' });
      const fetcher = vi.fn(async () => Response.json({ data: { id: 'txn_test' } }));
      const billing = new SubscriptionBillingService(store, new PaddleSubscriptionProvider(() => config, fetcher), true);
      await billing.checkout(org.id, 'team', { success: 'https://example.test/', cancel: 'https://example.test/' }, 'paddle-checkout-1');
      expect((await billing.current(org.id)).plan).toBe('free');
      const forged = payload('evt_unrelated');
      forged.data.transaction_id = 'txn_unrelated';
      (forged.data as any).custom_data = { karmax_organization_id: org.id };
      let event = signed(forged);
      await billing.handleWebhook(event.raw, event.signature);
      expect((await billing.current(org.id)).plan).toBe('free');
      event = signed(payload('evt_created'));
      await billing.handleWebhook(event.raw, event.signature);
      expect(await billing.current(org.id)).toMatchObject({ plan: 'team', seats: 3, status: 'active' });
      expect(await billing.handleWebhook(event.raw, event.signature)).toEqual({ duplicate: true });
      const cancellation = payload('evt_cancel', 'canceled', '2026-09-24T12:01:00Z');
      event = signed(cancellation);
      await billing.handleWebhook(event.raw, event.signature);
      expect(await billing.current(org.id)).toMatchObject({ plan: 'free', status: 'canceled' });
    } finally { await store.close(); }
  });

  it.each(['network', '503', 'malformed'])('releases billing reservations after a failed preflight read: %s', async (failure) => {
    const store = await Store.create(':memory:', { hosted: true });
    try {
      const org = await store.createOrganization({ name: 'Retry reads', ownerUserId: 'owner' });
      let fail = false;
      const fetcher = vi.fn(async (_url: any, init: any) => {
        if (init.method === 'GET' && fail) {
          if (failure === 'network') throw new Error('connection lost');
          return failure === '503' ? new Response('unavailable', { status: 503 }) : Response.json({});
        }
        return Response.json({ data: { id: 'txn_test', status: 'draft',
          items: [{ price: { id: 'pri_individual' }, quantity: 1 }] } });
      });
      const billing = new SubscriptionBillingService(store, new PaddleSubscriptionProvider(() => config, fetcher), true);
      const urls = { success: 'https://example.test/', cancel: 'https://example.test/' };
      await billing.checkout(org.id, 'individual', urls, 'safe-read-first');
      fail = true;
      await expect(billing.checkout(org.id, 'individual', urls, 'safe-read-retry')).rejects.toThrow();
      fail = false;
      await expect(billing.checkout(org.id, 'individual', urls, 'safe-read-retry')).resolves.toMatchObject({ checkoutSessionReference: 'txn_test' });
      expect(fetcher.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
    } finally { await store.close(); }
  });

  it('does not automatically retry ambiguous Paddle writes under a different request key', async () => {
    const store = await Store.create(':memory:', { hosted: true });
    try {
      const org = await store.createOrganization({ name: 'Ambiguous', ownerUserId: 'owner' });
      const fetcher = vi.fn(async () => { throw new Error('connection lost'); });
      const billing = new SubscriptionBillingService(store, new PaddleSubscriptionProvider(() => config, fetcher), true);
      const urls = { success: 'https://example.test/', cancel: 'https://example.test/' };
      await expect(billing.checkout(org.id, 'team', urls, 'paddle-uncertain-1')).rejects.toThrow();
      await expect(billing.checkout(org.id, 'team', urls, 'paddle-uncertain-2')).rejects.toThrow(/reconcil|progress/);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { await store.close(); }
  });

  it('reuses unchanged checkout and cancels the old link before replacing its plan', async () => {
    const store = await Store.create(':memory:', { hosted: true });
    try {
      const org = await store.createOrganization({ name: 'Repeat', ownerUserId: 'owner' });
      const transactions = new Map<string, any>();
      const fetcher = vi.fn(async (url: any, init: any) => {
        if (init.method === 'POST') {
          const id = `txn_test${transactions.size}`;
          const transaction = { id, status: 'draft', items: JSON.parse(init.body).items.map((i: any) => ({ price: { id: i.price_id }, quantity: i.quantity })) };
          transactions.set(id, transaction);
          return Response.json({ data: transaction });
        }
        const transaction = transactions.get(String(url).split('/').pop()!);
        if (init.method === 'PATCH') transaction.status = JSON.parse(init.body).status;
        return Response.json({ data: transaction });
      });
      const billing = new SubscriptionBillingService(store, new PaddleSubscriptionProvider(() => config, fetcher), true);
      const urls = { success: 'https://example.test/', cancel: 'https://example.test/' };
      const first = await billing.checkout(org.id, 'individual', urls, 'repeat-checkout-1');
      const repeated = await billing.checkout(org.id, 'individual', urls, 'repeat-checkout-2');
      expect(repeated.checkoutSessionReference).toBe(first.checkoutSessionReference);
      const second = await billing.checkout(org.id, 'team', urls, 'repeat-checkout-3');
      expect(second.checkoutSessionReference).not.toBe(first.checkoutSessionReference);
      expect(transactions.get(first.checkoutSessionReference).status).toBe('canceled');
      expect(second.commercialTerms.monthlyTotalPriceCents).toBe(1900);
      expect(fetcher.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(2);
      await expect(billing.assertOrganizationDeletionAllowed(org.id)).rejects.toThrow(/checkout/);
      await billing.cancel(org.id, 'cancel-pending-checkout');
      expect(transactions.get(second.checkoutSessionReference).status).toBe('canceled');
      await expect(billing.assertOrganizationDeletionAllowed(org.id)).resolves.toBeUndefined();
    } finally { await store.close(); }
  });

  it('recovers a lost create response using reads and the persisted server reference', async () => {
    const store = await Store.create(':memory:', { hosted: true });
    try {
      const org = await store.createOrganization({ name: 'Recover', ownerUserId: 'owner' });
      let transaction: any;
      const fetcher = vi.fn(async (_url: any, init: any) => {
        if (init.method === 'POST') {
          const request = JSON.parse(init.body);
          transaction = { id: 'txn_recovered', origin: 'api', status: 'draft', collection_mode: 'automatic', custom_data: request.custom_data,
            items: request.items.map((i: any) => ({ price: { id: i.price_id }, quantity: i.quantity })) };
          throw new Error('response lost');
        }
        return Response.json({ data: [transaction], meta: { pagination: { has_more: false } } });
      });
      const billing = new SubscriptionBillingService(store, new PaddleSubscriptionProvider(() => config, fetcher), true);
      const urls = { success: 'https://example.test/', cancel: 'https://example.test/' };
      await expect(billing.checkout(org.id, 'individual', urls, 'recover-checkout-1')).rejects.toThrow('response lost');
      expect(transaction.custom_data.karmax_request).not.toContain('recover-checkout-1');
      await expect(billing.reconcilePending(org.id)).rejects.toThrow(/progress/);
      await store.db.prepare('UPDATE subscription_billing_locks SET createdAt=? WHERE organizationId=?').run(Date.now() - 120_000, org.id);
      expect(await billing.reconcilePending(org.id)).toEqual({ reconciled: true, pending: false, applied: true });
      const recovered = await billing.checkout(org.id, 'individual', urls, 'recover-checkout-1');
      expect(recovered.checkoutSessionReference).toBe('txn_recovered');
      expect(fetcher.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
      expect((await billing.current(org.id)).plan).toBe('free');
    } finally { await store.close(); }
  });

  it('proves a lost write absent only from a complete read of Paddle (GH-5)', async () => {
    const reply = (data: unknown, more = false) => vi.fn(async () => Response.json({ data, meta: { pagination: { has_more: more, next: '/transactions?after=x' } } }));
    const reconcile = (fetcher: any, intent: any) => new PaddleSubscriptionProvider(() => config, fetcher).reconcileRequest(intent, 'reference', Date.now());
    const unchanged = { id: 'sub_test', status: 'active', scheduled_change: null, items: [{ price: { id: 'pri_individual' }, quantity: 1 }] };
    expect(await reconcile(reply(unchanged), { kind: 'change', subscriptionId: 'sub_test', plan: 'team', seats: 1 })).toEqual({ absent: true });
    expect(await reconcile(reply(unchanged), { kind: 'cancel', subscriptionId: 'sub_test' })).toEqual({ absent: true });
    expect(await reconcile(reply({ id: 'txn_open', status: 'ready' }), { kind: 'abandon', checkoutId: 'txn_open' })).toEqual({ absent: true });
    const checkout = { kind: 'checkout', plan: 'individual', seats: 1, successUrl: 'https://example.test/' };
    expect(await reconcile(reply([]), checkout)).toEqual({ absent: true });
    // A partial search or an ambiguous one proves nothing.
    expect(await reconcile(reply([], true), checkout)).toBeNull();
    const twice = { id: 'txn_a', origin: 'api', status: 'draft', collection_mode: 'automatic', custom_data: { karmax_request: 'reference:checkout' },
      items: [{ price: { id: 'pri_individual' }, quantity: 1 }] };
    expect(await reconcile(reply([twice, { ...twice, id: 'txn_b' }]), checkout)).toBeNull();
  });

  it('releases a reservation Paddle never applied once the write can no longer land (GH-5)', async () => {
    const store = await Store.create(':memory:', { hosted: true });
    try {
      const org = await store.createOrganization({ name: 'Lost write', ownerUserId: 'owner' });
      let lose = true;
      const fetcher = vi.fn(async (_url: any, init: any) => {
        if (init.method === 'POST') {
          if (lose) throw new Error('connection reset');
          const request = JSON.parse(init.body);
          return Response.json({ data: { id: 'txn_retried', status: 'draft', collection_mode: 'automatic',
            items: request.items.map((i: any) => ({ price: { id: i.price_id }, quantity: i.quantity })) } });
        }
        return Response.json({ data: [], meta: { pagination: { has_more: false } } });
      });
      const billing = new SubscriptionBillingService(store, new PaddleSubscriptionProvider(() => config, fetcher), true);
      const urls = { success: 'https://example.test/', cancel: 'https://example.test/' };
      await expect(billing.checkout(org.id, 'individual', urls, 'lost-write-1')).rejects.toThrow('connection reset');
      const age = async (ms: number) => { await store.db.prepare('UPDATE subscription_billing_locks SET createdAt=? WHERE organizationId=?').run(Date.now() - ms, org.id); };
      // Absent from Paddle, but young enough that the write could still land: keep it.
      await age(2 * 60_000);
      expect(await billing.reconcilePending(org.id)).toEqual({ reconciled: false, pending: true });
      await expect(billing.checkout(org.id, 'individual', urls, 'lost-write-2')).rejects.toThrow(/reconcil|progress/);
      await age(11 * 60_000);
      expect(await billing.reconcilePending(org.id)).toEqual({ reconciled: true, pending: false, applied: false });
      lose = false;
      await expect(billing.checkout(org.id, 'individual', urls, 'lost-write-3')).resolves.toMatchObject({ checkoutSessionReference: 'txn_retried' });
      expect(fetcher.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(2);
    } finally { await store.close(); }
  });

  it('never adopts checkout recovery metadata from browser-origin transactions', async () => {
    const fetcher = vi.fn(async () => Response.json({ data: [{ id: 'txn_forged', origin: 'web', status: 'draft',
      collection_mode: 'automatic', custom_data: { karmax_request: 'reference:checkout' },
      items: [{ price: { id: 'pri_individual' }, quantity: 1 }] }], meta: { pagination: { has_more: false } } }));
    const provider = new PaddleSubscriptionProvider(() => config, fetcher);
    expect(await provider.reconcileRequest({ kind: 'checkout', plan: 'individual', seats: 1,
      successUrl: 'https://example.test/' }, 'reference', Date.now())).toBeNull();
  });

  it('serializes concurrent financial writes for an organization', async () => {
    const store = await Store.create(':memory:', { hosted: true });
    try {
      const org = await store.createOrganization({ name: 'Concurrent', ownerUserId: 'owner' });
      let finish!: () => void;
      const gate = new Promise<void>(resolve => { finish = resolve; });
      let started!: () => void;
      const startedPromise = new Promise<void>(resolve => { started = resolve; });
      const fetcher = vi.fn(async () => { started(); await gate; return Response.json({ data: { id: 'txn_one' } }); });
      const billing = new SubscriptionBillingService(store, new PaddleSubscriptionProvider(() => config, fetcher), true);
      const urls = { success: 'https://example.test/', cancel: 'https://example.test/' };
      const first = billing.checkout(org.id, 'team', urls, 'concurrent-first');
      await startedPromise;
      await expect(billing.checkout(org.id, 'team', urls, 'concurrent-second')).rejects.toThrow(/progress/);
      finish(); await first;
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { await store.close(); }
  });

  it('skips repeated changes and cancellation already reflected at Paddle', async () => {
    const fetcher = vi.fn(async () => Response.json({ data: { id: 'sub_test', scheduled_change: { action: 'cancel' },
      items: [{ price: { id: 'pri_team' }, quantity: 1 }] } }));
    const provider = new PaddleSubscriptionProvider(() => config, fetcher);
    await provider.changePlan({ subscriptionId: 'sub_test', plan: 'team', seats: 1, items: {}, idempotencyKey: 'change-repeat' });
    await provider.updateSeats({ subscriptionId: 'sub_test', seats: 1, idempotencyKey: 'seats-repeat' });
    await provider.cancelAtPeriodEnd({ subscriptionId: 'sub_test', idempotencyKey: 'cancel-repeat' });
    expect(fetcher.mock.calls.every((call: any) => call[1].method === 'GET')).toBe(true);
  });

  it('isolates organizations sharing a payer and retries out-of-order lifecycle events', async () => {
    const store = await Store.create(':memory:', { hosted: true });
    try {
      const a = await store.createOrganization({ name: 'First', ownerUserId: 'owner' });
      const b = await store.createOrganization({ name: 'Second', ownerUserId: 'owner' });
      let serial = 0;
      const fetcher = vi.fn(async () => Response.json({ data: { id: `txn_${++serial}` } }));
      const billing = new SubscriptionBillingService(store, new PaddleSubscriptionProvider(() => config, fetcher), true);
      const urls = { success: 'https://example.test/', cancel: 'https://example.test/' };
      await billing.checkout(a.id, 'team', urls, 'payer-first-checkout');
      await billing.checkout(b.id, 'team', urls, 'payer-second-checkout');
      const first = payload('evt_first'); first.data.transaction_id = 'txn_1'; first.data.id = 'sub_first';
      const second = payload('evt_second'); second.data.transaction_id = 'txn_2'; second.data.id = 'sub_second';
      const update = { ...second, event_id: 'evt_update', event_type: 'subscription.updated', occurred_at: '2026-09-24T12:01:00.456Z',
        data: { ...second.data, status: 'past_due' } };
      let event = signed(update);
      await expect(billing.handleWebhook(event.raw, event.signature)).rejects.toThrow(/association/);
      for (const data of [first, second, update]) { event = signed(data); await billing.handleWebhook(event.raw, event.signature); }
      expect(await billing.current(a.id)).toMatchObject({ status: 'active', plan: 'team' });
      expect(await billing.current(b.id)).toMatchObject({ status: 'past_due', access: 'grace' });
      event = signed({ ...update, event_id: 'evt_recovered', occurred_at: '2026-09-24T12:02:00.789Z', data: { ...update.data, status: 'active' } });
      await billing.handleWebhook(event.raw, event.signature);
      expect(await billing.current(b.id)).toMatchObject({ status: 'active', access: 'active' });
    } finally { await store.close(); }
  });
});

/** Paddle's API as a list of scripted replies, keyed by "METHOD path". */
function paddleApi(routes: Record<string, unknown | ((body: any) => unknown)>) {
  const requests: Array<{ method: string; url: string; body?: any; headers: Record<string, string> }> = [];
  const fetcher = vi.fn(async (url: any, init: any) => {
    const parsed = new URL(String(url));
    const key = `${init.method} ${parsed.pathname}${parsed.search}`;
    requests.push({ method: init.method, url: String(url), body: init.body && JSON.parse(init.body), headers: init.headers });
    const route = routes[key] ?? routes[`${init.method} ${parsed.pathname}`];
    if (route === undefined) return Response.json({ error: { code: 'not_found' } }, { status: 404 });
    const reply = typeof route === 'function' ? (route as (body: any) => unknown)(init.body && JSON.parse(init.body)) : route;
    return reply instanceof Response ? reply : Response.json({ data: reply });
  });
  return { fetcher, requests, provider: (overrides: Partial<typeof config> = {}) =>
    new PaddleSubscriptionProvider(() => ({ ...config, ...overrides }), fetcher as any) };
}

const included = HOSTED_PLANS.team.includedActiveUsers;
const teamItems = (seats: number) => [{ price: { id: 'pri_team' }, quantity: 1 },
  ...(seats > included ? [{ price: { id: 'pri_seat' }, quantity: seats - included }] : [])];

// Each provider operation on its own, against a fake Paddle API (CI-38k).
describe('Paddle provider operations', () => {
  it('is configured only with keys, a client token and all three prices', async () => {
    expect(await new PaddleSubscriptionProvider(() => config).configured()).toBe(true);
    for (const missing of ['apiKey', 'webhookSecret', 'clientToken', 'individualPriceId', 'teamBasePriceId', 'teamSeatPriceId'] as const)
      expect(await new PaddleSubscriptionProvider(() => ({ ...config, [missing]: undefined })).configured()).toBe(false);
    expect(await new PaddleSubscriptionProvider(() => ({ ...config, teamSeatPriceId: '' })).catalog()).toBeUndefined();
    await expect(new PaddleSubscriptionProvider(() => config).createCustomer()).rejects.toThrow(/during checkout/);
  });

  it('prices checkouts on the server and refuses seat counts it cannot bill', async () => {
    const api = paddleApi({ 'POST /transactions': { id: 'txn_individual' } });
    const input = { organizationId: 'org', customerId: '', successUrl: 'https://karmax.example/?ok', cancelUrl: 'https://karmax.example/', idempotencyKey: 'k' };
    await api.provider().createCheckout({ ...input, plan: 'individual', seats: 7 });
    expect(api.requests[0]!.body).toMatchObject({ items: [{ price_id: 'pri_individual', quantity: 1 }], collection_mode: 'automatic',
      custom_data: { karmax_request: 'k' }, checkout: { url: 'https://karmax.example/billing/checkout?success=https%3A%2F%2Fkarmax.example%2F%3Fok' } });
    for (const seats of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])
      await expect(api.provider().createCheckout({ ...input, plan: 'team', seats })).rejects.toThrow(new BillingRequestRejected('invalid seat count'));
    await expect(api.provider({ teamBasePriceId: undefined }).createCheckout({ ...input, plan: 'team', seats: 3 }))
      .rejects.toThrow(new BillingRequestRejected('Paddle prices are not configured'));
    expect(api.requests).toHaveLength(1);
  });

  it('does not hand out a checkout for a transaction id it cannot trust', async () => {
    const input = { organizationId: 'org', customerId: '', plan: 'individual' as const, seats: 1, successUrl: 'https://karmax.example/',
      cancelUrl: 'https://karmax.example/', idempotencyKey: 'k' };
    for (const reply of [{}, { id: 'txn_../../evil' }, { id: 'sub_123' }])
      await expect(paddleApi({ 'POST /transactions': reply }).provider().createCheckout(input))
        .rejects.toThrow('Paddle returned an invalid transaction; reconcile before retrying');
  });

  it('classifies failures by whether a write may have happened', async () => {
    const failing = (response: () => Response | Promise<Response>) => new PaddleSubscriptionProvider(() => config, vi.fn(async () => response()) as any);
    const input = { organizationId: 'org', customerId: '', plan: 'individual' as const, seats: 1, successUrl: 'https://karmax.example/',
      cancelUrl: 'https://karmax.example/', idempotencyKey: 'k' };
    // A definite 4xx rejection is safe to correct and retry.
    const rejected = await failing(() => Response.json({ error: { code: 'price_not_found' } }, { status: 400 })).createCheckout(input).catch((e) => e);
    expect(rejected).toBeInstanceOf(BillingRequestRejected);
    expect(rejected.message).toBe('Paddle request failed (400, price_not_found)');
    // A 5xx, a network failure or a reply without data may have landed.
    for (const response of [() => new Response('oops', { status: 502 }), () => Promise.reject(new Error('socket hang up')), () => Response.json({})]) {
      const error = await failing(response).createCheckout(input).catch((e) => e);
      expect(error).not.toBeInstanceOf(BillingRequestRejected);
    }
    expect((await failing(() => new Response('oops', { status: 502 })).createCheckout(input).catch((e) => e)).message)
      .toBe('Paddle request failed (502, unknown_error); reconcile before retrying');
    // A failed read performed no write at all.
    const read = await failing(() => Promise.reject(new Error('socket hang up'))).createPortal({ customerId: '', subscriptionId: 'sub_1', returnUrl: '', idempotencyKey: 'k' }).catch((e) => e);
    expect(read).toBeInstanceOf(BillingRequestRejected);
    // Without an API key nothing is sent.
    const fetcher = vi.fn();
    await expect(new PaddleSubscriptionProvider(() => ({ ...config, apiKey: undefined }), fetcher as any).cancelCheckout('txn_1'))
      .rejects.toThrow(new BillingRequestRejected('Paddle API key is not configured'));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('talks to the live API outside the sandbox', async () => {
    const api = paddleApi({ 'GET /subscriptions/sub_1': { id: 'sub_1', status: 'canceled' } });
    await api.provider({ environment: 'live' }).cancelAtPeriodEnd({ subscriptionId: 'sub_1', idempotencyKey: 'k' });
    expect(api.requests[0]).toMatchObject({ url: 'https://api.paddle.com/subscriptions/sub_1',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Paddle-Version': '1' } });
  });

  it('returns only a genuine Paddle payment-method link as the billing portal', async () => {
    const portal = (url: unknown) => paddleApi({ 'GET /subscriptions/sub_1': { id: 'sub_1', management_urls: { update_payment_method: url } } })
      .provider().createPortal({ customerId: '', subscriptionId: 'sub_1', returnUrl: '', idempotencyKey: 'k' });
    await expect(portal('https://sandbox-customer-portal.paddle.com/cpl_1')).resolves.toEqual({ url: 'https://sandbox-customer-portal.paddle.com/cpl_1' });
    await expect(portal('https://customer-portal.paddle.com/cpl_1')).resolves.toBeTruthy();
    for (const url of ['https://customer-portal.paddle.com.evil.example/', 'http://customer-portal.paddle.com/cpl', undefined])
      await expect(portal(url)).rejects.toThrow(new BillingRequestRejected('Paddle has not provided a billing portal link'));
    await expect(new PaddleSubscriptionProvider(() => config).createPortal({ customerId: '', returnUrl: '', idempotencyKey: 'k' }))
      .rejects.toThrow(new BillingRequestRejected('no Paddle subscription exists'));
  });

  it('changes a plan only when the items differ, prorating at the next period', async () => {
    const api = paddleApi({ 'GET /subscriptions/sub_1': { id: 'sub_1', items: teamItems(4) }, 'PATCH /subscriptions/sub_1': { id: 'sub_1' } });
    expect(await api.provider().changePlan({ subscriptionId: 'sub_1', plan: 'team', seats: 4, items: {}, idempotencyKey: 'k' })).toEqual({ id: 'sub_1' });
    expect(api.requests.map((r) => r.method)).toEqual(['GET']);
    await api.provider().changePlan({ subscriptionId: 'sub_1', plan: 'individual', seats: 1, items: {}, idempotencyKey: 'k' });
    expect(api.requests.at(-1)).toMatchObject({ method: 'PATCH',
      body: { items: [{ price_id: 'pri_individual', quantity: 1 }], proration_billing_mode: 'prorated_next_billing_period' } });
  });

  it('schedules cancellation once, at the end of the period', async () => {
    for (const current of [{ status: 'canceled' }, { status: 'active', scheduled_change: { action: 'cancel' } }]) {
      const api = paddleApi({ 'GET /subscriptions/sub_1': { id: 'sub_1', ...current } });
      expect(await api.provider().cancelAtPeriodEnd({ subscriptionId: 'sub_1', idempotencyKey: 'k' })).toEqual({ id: 'sub_1' });
      expect(api.requests).toHaveLength(1);
    }
    const api = paddleApi({ 'GET /subscriptions/sub_1': { id: 'sub_1', status: 'active', scheduled_change: { action: 'pause' } },
      'POST /subscriptions/sub_1/cancel': { id: 'sub_1' } });
    await api.provider().cancelAtPeriodEnd({ subscriptionId: 'sub_1', idempotencyKey: 'k' });
    expect(api.requests.at(-1)).toMatchObject({ method: 'POST', body: { effective_from: 'next_billing_period' } });
  });

  it('changes seats only on a plain Team subscription', async () => {
    const seats = (items: unknown, count = 5) => {
      const api = paddleApi({ 'GET /subscriptions/sub_1': { id: 'sub_1', items }, 'PATCH /subscriptions/sub_1': { id: 'sub_1' } });
      return { api, result: api.provider().updateSeats({ subscriptionId: 'sub_1', seats: count, idempotencyKey: 'k' }) };
    };
    await expect(seats([{ price: { id: 'pri_individual' }, quantity: 1 }]).result)
      .rejects.toThrow(new BillingRequestRejected('cannot update seats on a non-Team Paddle subscription'));
    await expect(seats([...teamItems(3), { price: { id: 'pri_addon' }, quantity: 1 }]).result)
      .rejects.toThrow(new BillingRequestRejected('Paddle subscription has unexpected items; reconcile before changing seats'));
    const unchanged = seats(teamItems(5));
    await unchanged.result;
    expect(unchanged.api.requests.map((r) => r.method)).toEqual(['GET']);
    const grown = seats(teamItems(5), 8);
    await grown.result;
    expect(grown.api.requests.at(-1)!.body.items).toEqual([{ price_id: 'pri_team', quantity: 1 }, { price_id: 'pri_seat', quantity: 8 - included }]);
  });

  it('cancels an unpaid checkout, never one Paddle is already charging', async () => {
    const cancel = (status: string, patched = 'canceled') => {
      const api = paddleApi({ 'GET /transactions/txn_1': { id: 'txn_1', status }, 'PATCH /transactions/txn_1': { id: 'txn_1', status: patched } });
      return { api, result: api.provider().cancelCheckout('txn_1') };
    };
    const already = cancel('canceled');
    await expect(already.result).resolves.toEqual({ id: 'txn_1' });
    expect(already.api.requests).toHaveLength(1);
    for (const status of ['paid', 'completed', 'billed'])
      await expect(cancel(status).result).rejects.toThrow(new BillingRequestRejected('payment is already processing; wait for subscription confirmation before canceling'));
    const open = cancel('ready');
    await expect(open.result).resolves.toEqual({ id: 'txn_1' });
    expect(open.api.requests.at(-1)).toMatchObject({ method: 'PATCH', body: { status: 'canceled' } });
    await expect(cancel('draft', 'draft').result).rejects.toThrow('Paddle checkout cancellation needs reconciliation');
  });

  it('refuses to resume a checkout Paddle is already processing', async () => {
    const api = paddleApi({ 'GET /transactions/txn_1': { id: 'txn_1', status: 'paid', items: [] } });
    await expect(api.provider().resumeCheckout({ checkoutId: 'txn_1', plan: 'individual', seats: 1, successUrl: 'https://karmax.example/' } as any))
      .rejects.toThrow(/processing the existing checkout/);
    const canceled = paddleApi({ 'GET /transactions/txn_1': { id: 'txn_1', status: 'canceled' } });
    expect(await canceled.provider().resumeCheckout({ checkoutId: 'txn_1', plan: 'individual', seats: 1, successUrl: 'https://karmax.example/' } as any)).toBeNull();
  });
});

describe('Paddle webhook verification', () => {
  const provider = new PaddleSubscriptionProvider(() => config);

  it('rejects signatures it cannot pin to one fresh timestamp', async () => {
    const event = signed(payload('evt_sig'));
    const ts = /ts=(\d+)/.exec(event.signature)![1]!;
    const h1 = /h1=([a-f0-9]+)/.exec(event.signature)![1]!;
    for (const signature of [`ts=${ts};ts=${ts};h1=${h1}`, `h1=${h1}`, `ts=${ts}`, `ts=${ts};h1=${h1.slice(0, 63)}`, `ts=${ts};h1=zz${h1.slice(2)}`,
      `ts=${Number(ts) + 301};h1=${h1}`, `ts=abc;h1=${h1}`])
      await expect(provider.verifyWebhook(event.raw, signature)).rejects.toThrow(/signature/);
    await expect(new PaddleSubscriptionProvider(() => ({ ...config, webhookSecret: undefined })).verifyWebhook(event.raw, event.signature))
      .rejects.toThrow(/signature/);
    // Whitespace around the parts is tolerated.
    await expect(provider.verifyWebhook(event.raw, ` ts=${ts} ; h1=${h1} `)).resolves.toMatchObject({ id: 'evt_sig' });
  });

  it('ignores event types it does not act on, and refuses malformed ones', async () => {
    const other = signed({ event_id: 'evt_txn', event_type: 'transaction.completed', occurred_at: '2026-09-24T12:00:00Z', data: { id: 'txn_1' } });
    expect(await provider.verifyWebhook(other.raw, other.signature)).toEqual({ id: 'evt_txn', type: 'ignored',
      created: Date.parse('2026-09-24T12:00:00Z') / 1000, data: { object: {} } });
    for (const broken of [{ event_id: '' }, { occurred_at: 'yesterday' }, { event_type: 7 }, { data: null }]) {
      const event = signed({ ...payload('evt_broken'), ...broken });
      await expect(provider.verifyWebhook(event.raw, event.signature)).rejects.toThrow('invalid Paddle webhook event');
    }
    for (const snapshot of [{ id: 'txn_1' }, { customer_id: 7 }, { status: 'deleted' }, { items: null }]) {
      const base = payload('evt_snapshot');
      const event = signed({ ...base, data: { ...base.data, ...snapshot } });
      await expect(provider.verifyWebhook(event.raw, event.signature)).rejects.toThrow('invalid Paddle subscription snapshot');
    }
  });

  it('maps lifecycle events onto the shared subscription states', async () => {
    const canceled = signed(payload('evt_canceled', 'canceled'));
    expect(await provider.verifyWebhook(canceled.raw, canceled.signature)).toMatchObject({ type: 'customer.subscription.deleted', checkoutId: undefined });
    const base = payload('evt_updated', 'past_due');
    const updated = signed({ ...base, event_type: 'subscription.updated',
      data: { ...base.data, scheduled_change: { action: 'cancel' }, current_billing_period: null } });
    expect(await provider.verifyWebhook(updated.raw, updated.signature)).toMatchObject({ type: 'customer.subscription.updated',
      checkoutId: undefined, data: { object: { status: 'past_due', cancel_at_period_end: true, current_period_end: undefined } } });
  });
});

describe('Paddle request reconciliation', () => {
  const checkout = { kind: 'checkout' as const, plan: 'individual' as const, seats: 1, successUrl: 'https://karmax.example/' };
  const ours = { id: 'txn_ours', origin: 'api', status: 'draft', collection_mode: 'automatic', custom_data: { karmax_request: 'ref:checkout' },
    items: [{ price: { id: 'pri_individual' }, quantity: 1 }] };
  const page = (data: unknown[], next?: string) => Response.json({ data, meta: { pagination: { has_more: !!next, next } } });

  it('recovers the transaction it created by its stored reference, across pages', async () => {
    const api = paddleApi({
      'GET /transactions': (() => { let n = 0; return () => (n++ === 0
        ? page([{ ...ours, id: 'txn_other', custom_data: { karmax_request: 'other:checkout' } }], 'https://sandbox-api.paddle.com/transactions?after=txn_other')
        : page([ours])); })(),
    });
    expect(await api.provider().reconcileRequest(checkout, 'ref', Date.parse('2026-09-24T12:00:00Z'))).toEqual({ id: 'txn_ours',
      url: 'https://karmax.example/billing/checkout?success=https%3A%2F%2Fkarmax.example%2F&_ptxn=txn_ours' });
    expect(api.requests[0]!.url).toBe('https://sandbox-api.paddle.com/transactions?per_page=200&origin=api&created_at[GTE]=2026-09-24T11%3A59%3A00.000Z');
    expect(api.requests[1]!.url).toBe('https://sandbox-api.paddle.com/transactions?after=txn_other');
  });

  it('will not follow pagination off the Paddle API', async () => {
    const api = paddleApi({ 'GET /transactions': page([], 'https://evil.example/transactions?after=x') });
    await expect(api.provider().reconcileRequest(checkout, 'ref', Date.now())).rejects.toThrow('invalid Paddle reconciliation pagination URL');
    expect(api.requests).toHaveLength(1);
  });

  it('gives up, proving nothing, after twenty pages', async () => {
    const api = paddleApi({ 'GET /transactions': () => page([], '/transactions?after=more') });
    expect(await api.provider().reconcileRequest(checkout, 'ref', Date.now())).toBeNull();
    expect(api.requests).toHaveLength(20);
  });

  it('refuses to adopt a match that is not the checkout it asked for', async () => {
    for (const change of [{ collection_mode: 'manual' }, { id: 'txn_UPPER' }, { items: [{ price: { id: 'pri_team' }, quantity: 1 }] }]) {
      const api = paddleApi({ 'GET /transactions': page([{ ...ours, ...change }]) });
      expect(await api.provider().reconcileRequest(checkout, 'ref', Date.now())).toBeNull();
    }
    const invalid = paddleApi({ 'GET /transactions': Response.json({ data: { not: 'a list' } }) });
    await expect(invalid.provider().reconcileRequest(checkout, 'ref', Date.now())).rejects.toThrow(/invalid data/);
  });

  it('checks a known checkout id first and searches only if it was canceled', async () => {
    const direct = paddleApi({ 'GET /transactions/txn_ours': ours });
    expect(await direct.provider().reconcileRequest({ ...checkout, checkoutId: 'txn_ours' }, 'ref', Date.now())).toMatchObject({ id: 'txn_ours' });
    expect(direct.requests).toHaveLength(1);
    const replaced = paddleApi({ 'GET /transactions/txn_old': { ...ours, id: 'txn_old', status: 'canceled' }, 'GET /transactions': page([]) });
    expect(await replaced.provider().reconcileRequest({ ...checkout, checkoutId: 'txn_old' }, 'ref', Date.now())).toEqual({ absent: true });
  });

  it('cannot reconcile an intent missing what it would compare', async () => {
    const api = paddleApi({ 'GET /subscriptions/sub_1': { id: 'sub_1', items: teamItems(3) }, 'GET /transactions/txn_1': { id: 'txn_1', status: 'canceled' } });
    const provider = api.provider();
    expect(await provider.reconcileRequest({ kind: 'abandon' }, 'ref', Date.now())).toBeNull();
    expect(await provider.reconcileRequest({ kind: 'change' }, 'ref', Date.now())).toBeNull();
    expect(await provider.reconcileRequest({ kind: 'seats', subscriptionId: 'sub_1', plan: 'team' }, 'ref', Date.now())).toBeNull();
    expect(await provider.reconcileRequest({ kind: 'checkout', plan: 'team', seats: 3 }, 'ref', Date.now())).toBeNull();
    expect(api.requests).toHaveLength(1);
    // What was asked for is already true at Paddle.
    expect(await provider.reconcileRequest({ kind: 'seats', subscriptionId: 'sub_1', plan: 'team', seats: 3 }, 'ref', Date.now())).toEqual({ id: 'sub_1' });
    expect(await provider.reconcileRequest({ kind: 'abandon', checkoutId: 'txn_1' }, 'ref', Date.now())).toEqual({ id: 'txn_1' });
  });
});
