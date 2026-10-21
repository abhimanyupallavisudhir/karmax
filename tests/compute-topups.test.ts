// Auto top-up of managed compute (wiki features/managed-compute § Auto top-up):
// an organization that opts in buys $10 of compute at a time, charged at once
// to its Paddle subscription's saved payment method, up to its monthly cap; the
// credit lasts until used.
import { afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { PaddleSubscriptionProvider, type PaddleRuntimeConfig } from '../src/billing/paddle.js';
import { SubscriptionBillingService } from '../src/billing/subscriptions.js';
import { COMPUTE_TOP_UP, ComputeTopUps } from '../src/billing/compute-topups.js';
import { Store } from '../src/store/db.js';
import { closeComputeMonths, computeCredit } from '../src/world/managed-compute.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const config: PaddleRuntimeConfig = { environment: 'sandbox', apiKey: 'pdl_sdbx_apikey_test', webhookSecret: 'pdl_ntfset_test',
  clientToken: 'test_token', individualPriceId: 'pri_individual', teamBasePriceId: 'pri_team', teamSeatPriceId: 'pri_seat',
  computePackPriceId: 'pri_compute', computePackProductId: 'pro_compute' };
const item = (price: string, quantity: number) => ({ price: { id: price, product_id: 'pro_plan' }, quantity });
const signed = (value: unknown) => {
  const raw = Buffer.from(JSON.stringify(value));
  const timestamp = Math.floor(Date.now() / 1000);
  return { raw, signature: `ts=${timestamp};h1=${crypto.createHmac('sha256', config.webhookSecret!).update(`${timestamp}:`).update(raw).digest('hex')}` };
};

/** A Paddle API with one subscription and its one-time charges. `next` is
 * what the next charge does: get paid, be declined outright (402), go past
 * due, or be made with its answer lost. */
function paddle() {
  const charges: any[] = [];
  const transactions: any[] = [];
  let next: 'completed' | 'declined' | 'past_due' | 'lost' = 'completed';
  const fetcher = vi.fn(async (url: any, init: any) => {
    const parsed = new URL(String(url));
    if (init.method === 'POST' && parsed.pathname === '/transactions') return Response.json({ data: { id: 'txn_checkout' } });
    if (init.method === 'POST' && parsed.pathname === '/subscriptions/sub_1/charge') {
      const body = JSON.parse(init.body);
      charges.push(body);
      if (next === 'declined') return Response.json({ error: { code: 'subscription_payment_declined' } }, { status: 402 });
      transactions.push({ id: `txn_${transactions.length + 1}`, origin: 'subscription_charge', subscription_id: 'sub_1',
        status: next === 'lost' ? 'completed' : next, created_at: new Date().toISOString(),
        items: body.items.map((i: any) => ({ price: { id: `pri_nc_${transactions.length}`, ...i.price }, quantity: i.quantity })) });
      if (next === 'lost') throw new Error('connection reset');
      return Response.json({ data: { id: 'sub_1', status: 'active' } }, { status: 201 });
    }
    if (init.method === 'GET' && parsed.pathname === '/transactions') {
      expect(parsed.searchParams.get('subscription_id')).toBe('sub_1');
      expect(parsed.searchParams.get('origin')).toBe('subscription_charge');
      return Response.json({ data: transactions, meta: { pagination: { has_more: false } } });
    }
    if (parsed.pathname === '/subscriptions/sub_1') return Response.json({ data: { id: 'sub_1', status: 'active', items: [item('pri_individual', 1)] } });
    return Response.json({ error: { code: 'not_found' } }, { status: 404 });
  });
  return { provider: new PaddleSubscriptionProvider(() => config, fetcher as any), charges, transactions,
    then: (mode: typeof next) => { next = mode; } };
}

async function fixture(options: { offered?: boolean; plan?: boolean } = {}) {
  const store = await Store.create(':memory:', { hosted: true });
  cleanups.push(() => store.close());
  const organization = await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
  const api = paddle();
  const billing = new SubscriptionBillingService(store, api.provider, true);
  if (options.plan !== false) {
    await billing.checkout(organization.id, 'individual', { success: 'https://tavya.test/s', cancel: 'https://tavya.test/c' }, 'topup-checkout');
    const delivery = signed({ event_id: 'evt_created', event_type: 'subscription.created', occurred_at: new Date().toISOString(),
      data: { id: 'sub_1', customer_id: 'ctm_1', transaction_id: 'txn_checkout', status: 'active', items: [item('pri_individual', 1)], scheduled_change: null } });
    await billing.handleWebhook(delivery.raw, delivery.signature);
  }
  const told: Array<{ organizationId: string; subject: string; text: string }> = [];
  let offered = options.offered ?? true;
  const topUps = new ComputeTopUps(store, billing, { offered: async () => offered,
    tell: async (organizationId, message) => { told.push({ organizationId, ...message }); } });
  /** Managed usage booked this month, at the provider's price (half of tavya's). */
  const use = (id: string, chargeMicros: number, at = Date.now() - 60_000) => store.recordUsage({ id: `usage:aws:${id}`,
    organizationId: organization.id, provider: 'aws', kind: 'world.active', quantity: 60, unit: 'second', costMicros: chargeMicros / 2,
    startedAt: at - 60_000, endedAt: at, fundingSource: 'managed' });
  /** A hold just refused for want of credit (holdManagedCompute). */
  const short = (neededMicros = 1_000_000) => store.kvSet(`compute-short:${organization.id}`, JSON.stringify({ at: Date.now(), neededMicros }));
  return { store, organization, api, billing, topUps, told, use, short, offer: (value: boolean) => { offered = value; } };
}

describe('auto top-up', () => {
  it('buys $10 of compute when work runs short, credits it once Paddle has the payment, and stops at the monthly cap', async () => {
    const f = await fixture();
    expect(await f.topUps.status(f.organization.id)).toMatchObject({ enabled: false, offered: true, capCents: 5_000, amountCents: 1_000, spentCents: 0 });
    await f.topUps.configure(f.organization.id, { enabled: true, capCents: 2_000 }, 'owner');
    await f.use('most', 4_500_000);
    // $0.50 left, but nothing needs it: no charge.
    expect(await f.topUps.run()).toBe(0);
    expect(f.api.charges).toHaveLength(0);
    await f.short();
    expect(await f.topUps.run()).toBe(1);
    expect(f.api.charges).toEqual([{ effective_from: 'immediately', on_payment_failure: 'prevent_change', items: [{ quantity: 1,
      price: { product_id: 'pro_compute', name: 'Compute top-up', description: expect.stringMatching(/^Compute top-up topup_/),
        tax_mode: 'account_setting', unit_price: { amount: '1000', currency_code: 'USD' }, custom_data: { karmax_topup: expect.stringMatching(/^topup_/) } } }] }]);
    const [topUp] = await f.store.computeTopUps(f.organization.id);
    expect(topUp).toMatchObject({ state: 'paid', creditMicros: 10_000_000, amountCents: 1_000, transactionId: 'txn_1' });
    expect(await computeCredit(f.store, f.organization.id)).toMatchObject({ creditMicros: 5_000_000, topUpMicros: 10_000_000,
      usedMicros: 4_500_000, availableMicros: 10_500_000 });
    expect(await f.store.kvGet(`compute-short:${f.organization.id}`)).toBeUndefined();

    // Short again: a second $10 fits the $20 cap, a third does not.
    await f.use('more', 9_000_000);
    await f.short();
    expect(await f.topUps.run()).toBe(1);
    await f.use('again', 10_000_000);
    await f.short();
    expect(await f.topUps.run()).toBe(0);
    expect(f.api.charges).toHaveLength(2);
    expect(await f.topUps.status(f.organization.id)).toMatchObject({ spentCents: 2_000 });
    // Raising the cap lets the next one through.
    await f.topUps.configure(f.organization.id, { capCents: 3_000 }, 'owner');
    expect(await f.topUps.run()).toBe(1);
  });

  it('keeps top-up credit past the month it was bought in, until used', async () => {
    const f = await fixture();
    const october = Date.UTC(2026, 9, 20), november = Date.UTC(2026, 10, 2);
    await f.store.createComputeTopUp({ id: 'topup_a', organizationId: f.organization.id, creditMicros: 10_000_000, amountCents: 1_000,
      subscriptionId: 'sub_1', requestedAt: october });
    await f.store.updateComputeTopUp('topup_a', { state: 'paid', settledAt: october });
    // October: $5 included, $8 used, so $3 of the top-up.
    await f.use('october', 8_000_000, october + 60_000);
    expect(await computeCredit(f.store, f.organization.id, october + 120_000)).toMatchObject({ topUpMicros: 10_000_000, availableMicros: 7_000_000 });
    expect(await computeCredit(f.store, f.organization.id, november)).toMatchObject({ creditMicros: 5_000_000, topUpMicros: 7_000_000,
      usedMicros: 0, availableMicros: 12_000_000 });
    // Closing October records what it drew; later usage of October no longer changes it.
    await closeComputeMonths(f.store, november);
    expect(await f.store.computeCreditMonths(f.organization.id)).toEqual(expect.arrayContaining([{ month: '2026-10', allowanceMicros: 5_000_000, drawnMicros: 3_000_000 }]));
    await f.use('late', 2_000_000, october + 180_000);
    expect((await computeCredit(f.store, f.organization.id, november)).topUpMicros).toBe(7_000_000);
  });

  it('never charges twice when Paddle\'s answer is lost: its records settle the charge', async () => {
    const f = await fixture();
    await f.topUps.configure(f.organization.id, { enabled: true }, 'owner');
    await f.use('most', 4_500_000);
    await f.short();
    f.api.then('lost');
    expect(await f.topUps.run()).toBe(1);
    expect((await f.store.computeTopUps(f.organization.id))[0]).toMatchObject({ state: 'uncertain' });
    // Nothing more is bought while it is uncertain; the next pass reads Paddle's records.
    expect(await f.topUps.maybeTopUp(f.organization.id)).toBe(false);
    await f.topUps.run();
    expect((await f.store.computeTopUps(f.organization.id))[0]).toMatchObject({ state: 'paid', transactionId: 'txn_1' });
    expect(f.api.charges).toHaveLength(1);
  });

  it('pauses for a day and tells the owners when the card is declined, and credits a past-due charge Paddle collects later', async () => {
    const f = await fixture();
    await f.topUps.configure(f.organization.id, { enabled: true }, 'owner');
    await f.use('most', 4_500_000);
    await f.short();
    f.api.then('declined');
    expect(await f.topUps.run()).toBe(0);
    expect((await f.store.computeTopUps(f.organization.id))[0]).toMatchObject({ state: 'failed' });
    expect(f.told).toEqual([expect.objectContaining({ subject: 'Compute top-up for Acme was declined' })]);
    const paused = await f.topUps.status(f.organization.id);
    expect(paused.pausedUntil! - Date.now()).toBeGreaterThan(COMPUTE_TOP_UP.declinedPauseMs - 60_000);
    expect(await f.topUps.maybeTopUp(f.organization.id, Date.now() + 60 * 60_000)).toBe(false);
    // Turning it off and on again tries at once.
    await f.topUps.configure(f.organization.id, { enabled: false }, 'owner');
    await f.topUps.configure(f.organization.id, { enabled: true }, 'owner');
    f.api.then('past_due');
    expect(await f.topUps.run()).toBe(1);
    expect((await f.store.computeTopUps(f.organization.id))[0]).toMatchObject({ state: 'pending', error: 'declined' });
    expect(f.told).toHaveLength(2);
    expect((await computeCredit(f.store, f.organization.id)).topUpMicros).toBe(0);
    // Paddle's retry collects it: the credit arrives, nobody is told twice.
    f.api.transactions[0].status = 'completed';
    await f.topUps.run();
    expect((await f.store.computeTopUps(f.organization.id))[0]).toMatchObject({ state: 'paid' });
    expect((await computeCredit(f.store, f.organization.id)).topUpMicros).toBe(10_000_000);
    expect(f.told).toHaveLength(2);
  });

  it('is offered only once the billing terms describing it are approved, and only on an active paid subscription', async () => {
    const f = await fixture({ offered: false });
    await expect(f.topUps.configure(f.organization.id, { enabled: true }, 'owner')).rejects.toThrow('auto top-up is not offered yet');
    f.offer(true);
    await expect(f.topUps.configure(f.organization.id, { enabled: true, capCents: 500 }, 'owner')).rejects.toThrow(/monthly cap/);
    await f.topUps.configure(f.organization.id, { enabled: true }, 'owner');
    // Terms withdrawn (a new version not approved yet): nothing is bought.
    f.offer(false);
    await f.use('most', 4_500_000);
    await f.short();
    expect(await f.topUps.run()).toBe(0);
    const free = await fixture({ plan: false });
    expect(await free.topUps.status(free.organization.id)).toMatchObject({ offered: false, reason: 'auto top-up needs an active paid subscription' });
  });
});
