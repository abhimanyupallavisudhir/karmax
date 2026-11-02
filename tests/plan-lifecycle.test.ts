import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { PaddleSubscriptionProvider, type PaddleRuntimeConfig } from '../src/billing/paddle.js';
import { SubscriptionBillingService } from '../src/billing/subscriptions.js';
import { Store } from '../src/store/db.js';

// Every plan path an owner takes, end to end: the real billing service and
// Paddle adapter against a Paddle stub that keeps subscription state the way
// Paddle does (a PATCH replaces the items; a cancellation is scheduled for the
// period end and withdrawn only on its own) and sends signed notifications of
// it. Access always follows the signed notifications, never the request.

const GIB = 1024 ** 3;
const config: PaddleRuntimeConfig = { environment: 'sandbox', apiKey: 'pdl_sdbx_apikey_lifecycle',
  webhookSecret: 'pdl_ntfset_lifecycle', clientToken: 'test_lifecycle', individualPriceId: 'pri_individual',
  individualProductId: 'pro_individual', teamBasePriceId: 'pri_team', teamSeatPriceId: 'pri_seat', teamProductId: 'pro_team',
  storagePackPriceId: 'pri_storage', storagePackProductId: 'pro_storage', computePackPriceId: 'pri_compute', computePackProductId: 'pro_compute' };
const PRODUCT: Record<string, string> = { pri_individual: 'pro_individual', pri_team: 'pro_team', pri_seat: 'pro_team',
  pri_storage: 'pro_storage', pri_compute: 'pro_compute' };
const urls = { success: 'https://tavya.test/settings?billing=success', cancel: 'https://tavya.test/settings' };

class PaddleSandbox {
  readonly transactions = new Map<string, any>();
  readonly subscriptions = new Map<string, any>();
  readonly writes: Array<{ method: string; path: string; body: any }> = [];
  private clock = Date.parse('2026-11-02T10:00:00Z');
  private next = 0;

  readonly fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== 'GET') this.writes.push({ method, path: url.pathname, body });
    if (method === 'POST' && url.pathname === '/transactions') {
      const id = `txn_${String(++this.next).padStart(8, '0')}`;
      const transaction = { id, status: 'ready', origin: 'api', collection_mode: body.collection_mode, custom_data: body.custom_data,
        items: body.items.map((item: any) => ({ price: { id: item.price_id }, quantity: item.quantity })) };
      this.transactions.set(id, transaction);
      return Response.json({ data: transaction });
    }
    const transaction = this.transactions.get(url.pathname.match(/^\/transactions\/([^/]+)$/)?.[1] ?? '');
    if (transaction && method === 'GET') return Response.json({ data: transaction });
    const [, id, action] = url.pathname.match(/^\/subscriptions\/([^/]+)(?:\/(cancel))?$/) ?? [];
    const subscription = this.subscriptions.get(id ?? '');
    if (!subscription) return Response.json({ error: { code: 'not_found' } }, { status: 404 });
    if (method === 'GET') return Response.json({ data: subscription });
    if (method === 'POST' && action === 'cancel') {
      subscription.scheduled_change = { action: 'cancel', effective_at: subscription.current_billing_period.ends_at };
      return Response.json({ data: subscription });
    }
    if (method === 'PATCH') {
      if ('scheduled_change' in body && Object.keys(body).length > 1)
        return Response.json({ error: { code: 'bad_request' } }, { status: 400 });
      if ('scheduled_change' in body) subscription.scheduled_change = body.scheduled_change;
      else subscription.items = body.items.map((item: any) => this.item(item.price_id, item.quantity));
      return Response.json({ data: subscription });
    }
    return Response.json({ error: { code: 'not_found' } }, { status: 404 });
  }) as typeof fetch;

  private item(price: string, quantity: number) { return { price: { id: price, product_id: PRODUCT[price] }, quantity }; }

  /** The buyer pays a checkout: Paddle makes its subscription. */
  pay(transactionId: string, subscriptionId: string) {
    const transaction = this.transactions.get(transactionId)!;
    transaction.status = 'completed';
    this.subscriptions.set(subscriptionId, { id: subscriptionId, customer_id: 'ctm_owner', transaction_id: transactionId, status: 'active',
      current_billing_period: { ends_at: '2026-12-02T10:00:00Z' }, scheduled_change: null,
      items: transaction.items.map((item: any) => this.item(item.price.id, item.quantity)) });
    return this.notify('subscription.created', subscriptionId);
  }

  /** The signed notification of a subscription as it now stands. */
  notify(type: string, subscriptionId: string, patch: Record<string, unknown> = {}) {
    const subscription = Object.assign(this.subscriptions.get(subscriptionId)!, patch);
    this.clock += 1000;
    const raw = Buffer.from(JSON.stringify({ event_id: `evt_${++this.next}`, event_type: type,
      occurred_at: new Date(this.clock).toISOString(), data: subscription }));
    const ts = Math.floor(Date.now() / 1000);
    return { raw, signature: `ts=${ts};h1=${crypto.createHmac('sha256', config.webhookSecret!).update(`${ts}:`).update(raw).digest('hex')}` };
  }

  latest() { return [...this.transactions.values()].at(-1)!; }
}

async function setup() {
  const store = await Store.create(':memory:', { hosted: true });
  const org = await store.createOrganization({ name: 'Lifecycle', ownerUserId: 'owner' });
  const paddle = new PaddleSandbox();
  const billing = new SubscriptionBillingService(store, new PaddleSubscriptionProvider(() => config, paddle.fetch), true);
  const deliver = (notification: { raw: Buffer; signature: string }) => billing.handleWebhook(notification.raw, notification.signature);
  const plan = async () => (await store.organizationEntitlements(org.id));
  const state = () => billing.current(org.id);
  let key = 0;
  const k = (what: string) => `lifecycle-${what}-${++key}`;
  return { store, org, paddle, billing, deliver, plan, state, k };
}

describe('every plan path against a faithful Paddle', () => {
  it('subscribes, upgrades, adds seats, downgrades, buys packs, cancels, keeps, ends and resubscribes', async () => {
    const { store, org, paddle, billing, deliver, plan, state, k } = await setup();
    try {
      // Subscribe: a checkout grants nothing until Paddle says it is paid.
      await billing.checkout(org.id, 'individual', urls, k('checkout'));
      expect(paddle.latest().items).toEqual([{ price: { id: 'pri_individual' }, quantity: 1 }]);
      expect((await plan()).plan).toBe('free');
      await deliver(paddle.pay(paddle.latest().id, 'sub_1'));
      expect(await plan()).toMatchObject({ plan: 'individual', storageQuotaBytes: 50 * GIB, computeCreditMicros: 5_000_000 });
      expect(await state()).toMatchObject({ billedPlan: 'individual', status: 'active', billedMonthlyPriceCents: 900, teamSeats: null });

      // Upgrade: the same subscription, never a second checkout.
      await expect(billing.checkout(org.id, 'team', urls, k('second-checkout'))).rejects.toThrow(/Change plan/);
      await billing.changePlan(org.id, 'team', k('upgrade'));
      expect(paddle.writes.at(-1)).toMatchObject({ method: 'PATCH', body: { items: [{ price_id: 'pri_team', quantity: 1 }],
        proration_billing_mode: 'prorated_next_billing_period' } });
      expect((await plan()).plan).toBe('individual');
      await deliver(paddle.notify('subscription.updated', 'sub_1'));
      expect(await state()).toMatchObject({ plan: 'team', billedMonthlyPriceCents: 1_900, teamSeats: { total: 1, used: 1, autoBill: true } });

      // A seat ahead of an invitation, then the person; a second person is billed one on joining.
      await billing.seats(org.id, 2, k('seat'));
      expect(paddle.writes.at(-1)?.body.items).toEqual([{ price_id: 'pri_team', quantity: 1 }, { price_id: 'pri_seat', quantity: 1 }]);
      await deliver(paddle.notify('subscription.updated', 'sub_1'));
      expect((await state()).teamSeats).toMatchObject({ total: 2, used: 1, paid: 1 });
      await store.setOrganizationMembership(org.id, 'colleague', 'member');
      await store.setOrganizationMembership(org.id, 'another', 'member');
      await billing.syncSeats(org.id);
      expect(paddle.writes.at(-1)?.body.items).toEqual([{ price_id: 'pri_team', quantity: 1 }, { price_id: 'pri_seat', quantity: 2 }]);
      await deliver(paddle.notify('subscription.updated', 'sub_1'));
      expect(await state()).toMatchObject({ seatDeficit: 0, billedMonthlyPriceCents: 2_900, teamSeats: { total: 3, used: 3 } });
      expect(await plan()).toMatchObject({ maxActiveAgentRuns: 30, storageQuotaBytes: 120 * GIB, computeCreditMicros: 16_000_000 });

      // Downgrade: not with other people in the organization.
      await expect(billing.changePlan(org.id, 'individual', k('downgrade-early'))).rejects.toThrow(/remove additional active users/);
      await store.removeOrganizationMembership(org.id, 'colleague');
      await store.removeOrganizationMembership(org.id, 'another');
      await billing.changePlan(org.id, 'individual', k('downgrade'));
      expect(paddle.writes.at(-1)?.body.items).toEqual([{ price_id: 'pri_individual', quantity: 1 }]);
      await deliver(paddle.notify('subscription.updated', 'sub_1'));
      expect(await state()).toMatchObject({ plan: 'individual', billedMonthlyPriceCents: 900 });

      // Packs, named by what they give, on the same subscription.
      await billing.storagePacks(org.id, 2, k('storage'));
      await billing.computePacks(org.id, 1, k('compute'));
      expect(paddle.writes.at(-1)?.body.items).toEqual([{ price_id: 'pri_individual', quantity: 1 },
        { price_id: 'pri_storage', quantity: 2 }, { price_id: 'pri_compute', quantity: 1 }]);
      await deliver(paddle.notify('subscription.updated', 'sub_1'));
      expect(await plan()).toMatchObject({ storageQuotaBytes: 250 * GIB, computeCreditMicros: 15_000_000 });
      await billing.storagePacks(org.id, 1, k('storage-fewer'));
      await deliver(paddle.notify('subscription.updated', 'sub_1'));
      expect(await state()).toMatchObject({ storagePacks: 1, computePacks: 1, billedMonthlyPriceCents: 900 + 400 + 1_000 });

      // Cancel at the period end: access goes on until then.
      await billing.cancel(org.id, k('cancel'));
      expect(paddle.writes.at(-1)).toMatchObject({ method: 'POST', path: '/subscriptions/sub_1/cancel', body: { effective_from: 'next_billing_period' } });
      await deliver(paddle.notify('subscription.updated', 'sub_1'));
      expect(await state()).toMatchObject({ plan: 'individual', cancelAtPeriodEnd: true, currentPeriodEnd: Date.parse('2026-12-02T10:00:00Z') });

      // Changed their mind: keep it. The scheduled end goes in a write of its own.
      await billing.resume(org.id, k('resume'));
      expect(paddle.writes.at(-1)).toEqual({ method: 'PATCH', path: '/subscriptions/sub_1', body: { scheduled_change: null } });
      await deliver(paddle.notify('subscription.updated', 'sub_1'));
      expect(await state()).toMatchObject({ cancelAtPeriodEnd: false, status: 'active' });
      await expect(billing.resume(org.id, k('resume-again'))).rejects.toThrow(/no ending subscription/);

      // Cancel again and let the period end: Free, packs gone.
      await billing.cancel(org.id, k('cancel-again'));
      await deliver(paddle.notify('subscription.updated', 'sub_1'));
      await deliver(paddle.notify('subscription.canceled', 'sub_1', { status: 'canceled', scheduled_change: null }));
      expect(await plan()).toMatchObject({ plan: 'free', storagePacks: 0, computePacks: 0, storageQuotaBytes: 5 * GIB });
      expect(await state()).toMatchObject({ status: 'canceled', access: 'free' });
      await expect(billing.cancel(org.id, k('cancel-ended'))).rejects.toThrow(/no cancellable subscription/);

      // Resubscribe: a new checkout, a new subscription; the old one's late news changes nothing.
      await billing.checkout(org.id, 'team', urls, k('resubscribe'));
      await deliver(paddle.pay(paddle.latest().id, 'sub_2'));
      expect(await state()).toMatchObject({ plan: 'team', billedPlan: 'team', status: 'active' });
      await deliver(paddle.notify('subscription.updated', 'sub_1', { status: 'active' }));
      expect((await plan()).plan).toBe('team');
    } finally { await store.close(); }
  });

  it('keeps a plan through seven days of failed payments, then falls back to Free until it is paid', async () => {
    const { store, org, paddle, billing, deliver, plan, state, k } = await setup();
    try {
      await billing.checkout(org.id, 'individual', urls, k('checkout'));
      await deliver(paddle.pay(paddle.latest().id, 'sub_due'));
      await billing.storagePacks(org.id, 1, k('pack'));
      await deliver(paddle.notify('subscription.updated', 'sub_due'));
      await deliver(paddle.notify('subscription.past_due', 'sub_due', { status: 'past_due' }));
      const { graceEndsAt } = await state();
      expect(await state()).toMatchObject({ status: 'past_due', access: 'grace' });
      expect(await plan()).toMatchObject({ plan: 'individual', storagePacks: 1 });
      // Nothing new is bought on a failing card; what is there can still be removed.
      await expect(billing.storagePacks(org.id, 2, k('more'))).rejects.toThrow(/payment method/);
      expect('reason' in await billing.computeTopUpTarget(org.id)).toBe(true);
      await billing.reconcileEntitlements(graceEndsAt! + 1);
      expect(await plan()).toMatchObject({ plan: 'free', storagePacks: 0 });
      await deliver(paddle.notify('subscription.updated', 'sub_due', { status: 'active' }));
      expect(await plan()).toMatchObject({ plan: 'individual', storagePacks: 1 });
      expect('subscriptionId' in await billing.computeTopUpTarget(org.id)).toBe(true);
    } finally { await store.close(); }
  });

  it('combines a gift with a paid plan and paid packs, and keeps what is paid for when the gift goes', async () => {
    const { store, org, paddle, billing, deliver, plan, state, k } = await setup();
    try {
      await billing.checkout(org.id, 'individual', urls, k('checkout'));
      await deliver(paddle.pay(paddle.latest().id, 'sub_paid'));
      await billing.storagePacks(org.id, 1, k('pack'));
      await deliver(paddle.notify('subscription.updated', 'sub_paid'));
      // A better gifted plan wins; packs paid and gifted add up.
      await billing.gift(org.id, 'team', 'user:operator', k('gift'), 3);
      await billing.giftStoragePacks(org.id, 2, 'user:operator', k('gift-storage'));
      await billing.giftComputePacks(org.id, 1, 'user:operator', k('gift-compute'));
      expect(await plan()).toMatchObject({ plan: 'team', storagePacks: 1, giftedStoragePacks: 2, storageQuotaBytes: 400 * GIB,
        computeCreditMicros: 20_000_000, seatLimit: 3 });
      expect(await state()).toMatchObject({ billedPlan: 'individual', billedMonthlyPriceCents: 1_300, teamSeats: { total: 3, gifted: 3 } });
      // A gift never stops the subscription it sits beside, nor is cancelled by it.
      await billing.cancel(org.id, k('cancel'));
      await deliver(paddle.notify('subscription.canceled', 'sub_paid', { status: 'canceled' }));
      expect(await plan()).toMatchObject({ plan: 'team', storagePacks: 0, giftedStoragePacks: 2, storageQuotaBytes: 300 * GIB });
      // The gift removed: Free, but gifted packs stay until the operator sets them to 0.
      await billing.gift(org.id, null, 'user:operator', k('ungift'));
      expect(await plan()).toMatchObject({ plan: 'free', seatLimit: null, storageQuotaBytes: 205 * GIB, computeCreditMicros: 10_000_000 });
    } finally { await store.close(); }
  });
});
