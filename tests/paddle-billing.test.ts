import { describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { PaddleSubscriptionProvider } from '../src/billing/paddle.js';
import { FakeSubscriptionProvider, SubscriptionBillingService } from '../src/billing/subscriptions.js';
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
    expect(result).toEqual({ id: 'txn_test', url: 'https://example.test/billing/checkout?_ptxn=txn_test' });
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
      expect(await billing.reconcilePending(org.id)).toEqual({ reconciled: true, pending: false });
      const recovered = await billing.checkout(org.id, 'individual', urls, 'recover-checkout-1');
      expect(recovered.checkoutSessionReference).toBe('txn_recovered');
      expect(fetcher.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
      expect((await billing.current(org.id)).plan).toBe('free');
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
