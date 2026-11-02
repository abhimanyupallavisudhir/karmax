import { describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { BillingRequestRejected, PaddleSubscriptionProvider, type PaddleRuntimeConfig } from '../src/billing/paddle.js';
import { FakeSubscriptionProvider, SubscriptionBillingService } from '../src/billing/subscriptions.js';
import { EntitlementError } from '../src/domain/entitlements.js';
import { Store } from '../src/store/db.js';

// Team seats (wiki features/managed-compute § UI, ops/billing-paddle § Seats):
// a Team covers a number of people. A paid Team includes one and bills $5 for
// each more; a gifted Team covers the seats the operator gifted, and its owner
// buys more through Paddle beside the gift. Seats are added ahead of invites
// and removed when unused; they never go below the people in the organization.

const urls = { success: 'https://tavya.test/success', cancel: 'https://tavya.test/cancel' };
const event = (id: string, type: string, object: any, created: number) =>
  Buffer.from(JSON.stringify({ id, type, created, data: { object } }));

async function organization(plan: 'team' | 'individual' | null, members = 1) {
  const store = await Store.create(':memory:', { hosted: true });
  const org = await store.createOrganization({ name: `Seats ${crypto.randomUUID().slice(0, 8)}`, ownerUserId: 'owner' });
  // People first (a Team without limits takes them), then the plan under test.
  await store.setOrganizationPlan(org.id, 'team');
  for (let index = 1; index < members; index++) await store.setOrganizationMembership(org.id, `member-${index}`, 'member');
  await store.setOrganizationPlan(org.id, 'free');
  const provider = new FakeSubscriptionProvider();
  const billing = new SubscriptionBillingService(store, provider, true);
  let clock = 100;
  const deliver = (type: string, object: any) => billing.handleWebhook(event(`evt_${++clock}`, type, object, clock));
  /** A signed snapshot of the organization's subscription. */
  const snapshot = (status: string, items: { base?: 'team' | 'individual'; seats?: number; storage?: number }) => ({
    id: 'sub_seats', customer: `cus_${org.id}`, status, items: { data: [
      ...(items.base ? [{ id: 'si_base', price: { id: items.base === 'team' ? 'price_team_base' : 'price_individual' }, quantity: 1 }] : []),
      ...(items.seats ? [{ id: 'si_seat', price: { id: 'price_team_seat' }, quantity: items.seats }] : []),
      ...(items.storage ? [{ id: 'si_storage', price: { id: 'price_storage_pack' }, quantity: items.storage }] : []),
    ] } });
  if (plan) {
    await billing.checkout(org.id, plan, urls, `checkout-${org.id}`);
    await deliver('customer.subscription.updated', snapshot('active', { base: plan, seats: plan === 'team' ? members - 1 : 0 }));
  }
  const seats = async () => (await billing.current(org.id)).teamSeats;
  return { store, org, provider, billing, deliver, snapshot, seats };
}

async function giftedTeam(members = 1) {
  const f = await organization(null, members);
  await f.billing.gift(f.org.id, 'team', 'user:operator', `gift-${f.org.id}`);
  return f;
}

describe('seats on a paid Team', () => {
  it('shows the seats the subscription bills against the people using them', async () => {
    const f = await organization('team', 2);
    expect(await f.seats()).toEqual({ total: 2, used: 2, gifted: 0, paid: 1, included: 1, limit: null,
      autoBill: true, priceCents: 500 });
    await f.store.close();
  });

  it('adds seats ahead of invitations, granted only once the provider confirms them', async () => {
    const f = await organization('team', 1);
    expect(await f.billing.seats(f.org.id, 3, 'seats-to-three')).toEqual({ id: 'sub_seats' });
    expect(f.provider.calls.at(-1)).toMatchObject({ method: 'updateSeats', input: { subscriptionId: 'sub_seats', seats: 3 } });
    expect((await f.seats())?.total).toBe(1);
    await f.deliver('customer.subscription.updated', f.snapshot('active', { base: 'team', seats: 2 }));
    expect(await f.seats()).toMatchObject({ total: 3, used: 1, paid: 2 });
    // The same request again is the same request; it is not sent twice.
    await f.billing.seats(f.org.id, 3, 'seats-to-three');
    expect(f.provider.calls.filter((call) => call.method === 'updateSeats')).toHaveLength(1);
    await f.store.close();
  });

  it('removes unused seats, never one a person holds', async () => {
    const f = await organization('team', 2);
    await f.deliver('customer.subscription.updated', f.snapshot('active', { base: 'team', seats: 3 }));
    expect((await f.seats())?.total).toBe(4);
    await expect(f.billing.seats(f.org.id, 1, 'seats-below-people')).rejects.toThrow(/2 people .*remove members first/i);
    await f.billing.seats(f.org.id, 2, 'seats-to-two');
    expect(f.provider.calls.at(-1)).toMatchObject({ method: 'updateSeats', input: { seats: 2 } });
    for (const seats of [0, -1, 1.5, '3', null, 10_001])
      await expect(f.billing.seats(f.org.id, seats, `bad-seats-${String(seats)}`)).rejects.toThrow(/whole number/);
    await expect(f.billing.seats(f.org.id, 3, '')).rejects.toThrow(/Idempotency-Key/);
    await f.store.close();
  });

  it('bills a seat for someone who joins without one, and keeps a seat someone leaves', async () => {
    const f = await organization('team', 1);
    await f.store.setOrganizationMembership(f.org.id, 'joiner', 'member');
    await f.billing.syncSeats(f.org.id);
    expect(f.provider.calls.at(-1)).toMatchObject({ method: 'updateSeats', input: { seats: 2 } });
    await f.deliver('customer.subscription.updated', f.snapshot('active', { base: 'team', seats: 1 }));
    const calls = f.provider.calls.length;
    await f.store.removeOrganizationMembership(f.org.id, 'joiner');
    await f.billing.syncSeats(f.org.id);
    // The seat stays the owner's to remove: shrinking it on its own would take
    // back a seat bought for someone about to be invited.
    expect(f.provider.calls).toHaveLength(calls);
    expect(await f.seats()).toMatchObject({ total: 2, used: 1 });
    await f.store.close();
  });

  it('adds no seats while a payment is failing, but still lets the owner remove them', async () => {
    const f = await organization('team', 1);
    await f.deliver('customer.subscription.updated', f.snapshot('past_due', { base: 'team', seats: 1 }));
    await expect(f.billing.seats(f.org.id, 3, 'past-due-more')).rejects.toThrow(/payment method/);
    await f.billing.seats(f.org.id, 1, 'past-due-fewer');
    expect(f.provider.calls.at(-1)).toMatchObject({ method: 'updateSeats', input: { seats: 1 } });
    await f.store.close();
  });

  it('has no seats to change on another plan', async () => {
    const f = await organization('individual', 1);
    expect(await f.seats()).toBeNull();
    await expect(f.billing.seats(f.org.id, 2, 'individual-seats')).rejects.toThrow(/Team/);
    await f.store.close();
  });
});

describe('seats on a gifted Team', () => {
  it('covers the people there when the gift was given, and the operator can gift more', async () => {
    const f = await giftedTeam(2);
    expect(await f.seats()).toEqual({ total: 2, used: 2, gifted: 2, paid: 0, included: 2, limit: 2, autoBill: false, priceCents: 500 });
    expect(await f.billing.current(f.org.id)).toMatchObject({ seatDeficit: 0 });
    await f.billing.gift(f.org.id, 'team', 'user:operator', 'gift-five-seats', 5);
    expect(await f.seats()).toMatchObject({ total: 5, gifted: 5, limit: 5 });
    expect((await f.billing.currentGift(f.org.id))).toMatchObject({ plan: 'team', seats: 5 });
    await expect(f.billing.gift(f.org.id, 'team', 'user:operator', 'gift-no-seats', 0)).rejects.toThrow(/whole number/);
    await f.store.close();
  });

  it('admits people only into a free seat, and says where to add one', async () => {
    const f = await giftedTeam(1);
    expect(await f.store.organizationEntitlements(f.org.id)).toMatchObject({ seatLimit: 1, memberAdmissionAllowed: false });
    const refused = f.store.createOrganizationInvitation({ organizationId: f.org.id, email: 'new@example.test', invitedBy: 'owner' });
    await expect(refused).rejects.toBeInstanceOf(EntitlementError);
    await expect(refused).rejects.toThrow(/All 1 seat .*taken.*Plan & billing/);
    await expect(f.store.setOrganizationMembership(f.org.id, 'walk-in', 'member')).rejects.toThrow(/Plan & billing/);
    await f.billing.gift(f.org.id, 'team', 'user:operator', 'gift-two-seats', 2);
    await f.store.createOrganizationInvitation({ organizationId: f.org.id, email: 'new@example.test', invitedBy: 'owner' });
    await f.store.setOrganizationMembership(f.org.id, 'newcomer', 'member');
    // Agents never stop over seats: only new people wait for one.
    await f.billing.gift(f.org.id, 'team', 'user:operator', 'gift-one-seat-again', 1);
    expect(await f.store.organizationEntitlements(f.org.id)).toMatchObject({ agentRunAdmissionAllowed: true, memberAdmissionAllowed: false });
    await f.store.close();
  });

  it('buys the first seats beside the gift at checkout, then changes that subscription', async () => {
    const f = await giftedTeam(1);
    await expect(f.billing.seats(f.org.id, 3, 'gift-seats-direct')).rejects.toThrow(/checkout/);
    const checkout = await f.billing.checkoutPacks(f.org.id, { seats: 2 }, urls, 'gift-seat-checkout');
    expect(checkout.commercialTerms).toMatchObject({ planId: null, seats: 2, monthlyTotalPriceCents: 1_000 });
    expect(f.provider.calls.find((call) => call.method === 'createCheckout')?.input).toMatchObject({ seats: 2, storagePacks: 0, computePacks: 0 });
    expect(f.provider.calls.find((call) => call.method === 'createCheckout')?.input.plan).toBeUndefined();
    expect((await f.seats())?.total).toBe(1);

    await f.deliver('customer.subscription.created', f.snapshot('active', { seats: 2 }));
    expect(await f.seats()).toEqual({ total: 3, used: 1, gifted: 1, paid: 2, included: 1, limit: 3, autoBill: false, priceCents: 500 });
    expect(await f.billing.current(f.org.id)).toMatchObject({ plan: 'team', billedPlan: 'free', billedMonthlyPriceCents: 1_000 });
    await f.store.setOrganizationMembership(f.org.id, 'second', 'member');

    await f.billing.seats(f.org.id, 4, 'gift-seats-more');
    expect(f.provider.calls.at(-1)).toMatchObject({ method: 'updateAddOnSeats', input: { subscriptionId: 'sub_seats', extraSeats: 3 } });
    await expect(f.billing.seats(f.org.id, 1, 'gift-seats-below')).rejects.toThrow(/remove members first/i);
    await f.billing.seats(f.org.id, 2, 'gift-seats-fewer');
    expect(f.provider.calls.at(-1)).toMatchObject({ method: 'updateAddOnSeats', input: { extraSeats: 1 } });
    // Seats and packs share the one subscription beside the gift.
    await f.deliver('customer.subscription.updated', f.snapshot('active', { seats: 1, storage: 1 }));
    expect(await f.billing.current(f.org.id)).toMatchObject({ storagePacks: 1, billedMonthlyPriceCents: 500 + 400 });
    expect(await f.seats()).toMatchObject({ total: 2, paid: 1 });
    await f.store.close();
  });

  it('keeps paid seats while their subscription is paid for, and none once it lapses', async () => {
    const f = await giftedTeam(1);
    await f.billing.checkoutPacks(f.org.id, { seats: 1 }, urls, 'gift-seat-lapse');
    await f.deliver('customer.subscription.created', f.snapshot('active', { seats: 1 }));
    expect((await f.seats())?.total).toBe(2);
    await f.deliver('customer.subscription.deleted', f.snapshot('canceled', { seats: 1 }));
    expect(await f.seats()).toMatchObject({ total: 1, paid: 0, limit: 1 });
    await f.store.close();
  });

  it('needs a gifted Team for seats at checkout', async () => {
    const f = await organization(null, 1);
    await expect(f.billing.checkoutPacks(f.org.id, { seats: 1 }, urls, 'free-seat-checkout')).rejects.toThrow(/Team/);
    await f.billing.gift(f.org.id, 'individual', 'user:operator', 'gift-individual');
    await expect(f.billing.checkoutPacks(f.org.id, { seats: 1 }, urls, 'individual-seat-checkout')).rejects.toThrow(/Team/);
    for (const [index, seats] of [-1, 1.5, '1', 10_001].entries())
      await expect(f.billing.checkoutPacks(f.org.id, { seats }, urls, `bad-seat-count-${index}`)).rejects.toThrow(/whole number/);
    await f.store.close();
  });

  it('gives existing gifted Teams the seats their people hold when the column arrives', async () => {
    const f = await giftedTeam(3);
    await f.store.db.prepare('UPDATE subscription_gifts SET seats=NULL WHERE organizationId=?').run(f.org.id);
    await f.store.migrateGiftSeats();
    expect((await f.billing.currentGift(f.org.id))?.seats).toBe(3);
    await f.store.close();
  });

  it('has no seat limit on a Team the operator set directly, and nothing to bill', async () => {
    const f = await organization(null, 2);
    await f.store.setOrganizationPlan(f.org.id, 'team');
    expect(await f.seats()).toMatchObject({ total: null, used: 2, limit: null, autoBill: false });
    expect(await f.billing.current(f.org.id)).toMatchObject({ seatDeficit: 0 });
    await f.store.close();
  });
});

const config: PaddleRuntimeConfig = { environment: 'sandbox', apiKey: 'pdl_sdbx_apikey_test',
  webhookSecret: 'pdl_ntfset_test', clientToken: 'test_token', individualPriceId: 'pri_individual',
  teamBasePriceId: 'pri_team', teamSeatPriceId: 'pri_seat', storagePackPriceId: 'pri_pack', storagePackProductId: 'pro_pack' };
const item = (price: string, quantity: number) => ({ price: { id: price, product_id: price === 'pri_pack' ? 'pro_pack' : 'pro_plan' }, quantity });

/** A Paddle API holding one subscription; PATCH replaces its items, as Paddle does. */
function paddle(items: any[]) {
  const subscription: any = { id: 'sub_1', status: 'active', customer_id: 'ctm_1', items, scheduled_change: null };
  const writes: any[] = [];
  const transactions: any[] = [];
  const fetcher = vi.fn(async (url: any, init: any) => {
    const path = new URL(String(url)).pathname;
    if (init.method === 'POST' && path === '/transactions') {
      transactions.push(JSON.parse(init.body));
      return Response.json({ data: { id: 'txn_seats' } });
    }
    if (init.method === 'POST' && path === '/subscriptions/sub_1/cancel') {
      writes.push({ cancel: JSON.parse(init.body) });
      subscription.scheduled_change = { action: 'cancel' };
      return Response.json({ data: subscription });
    }
    if (path !== '/subscriptions/sub_1') return Response.json({ error: { code: 'not_found' } }, { status: 404 });
    if (init.method === 'PATCH') {
      const body = JSON.parse(init.body);
      if ('scheduled_change' in body && Object.keys(body).length > 1)
        return Response.json({ error: { code: 'bad_request' } }, { status: 400 });
      writes.push(body);
      if ('scheduled_change' in body) subscription.scheduled_change = body.scheduled_change;
      else subscription.items = body.items.map((i: any) => item(i.price_id, i.quantity));
    }
    return Response.json({ data: subscription });
  });
  const provider = new PaddleSubscriptionProvider(() => config, fetcher as any);
  return { provider, writes, transactions, subscription };
}

describe('Paddle seats beside a gifted Team', () => {
  it('checks out seats alone, and with packs', async () => {
    const api = paddle([]);
    await api.provider.createCheckout({ organizationId: 'org', customerId: '', seats: 2, storagePacks: 1,
      successUrl: 'https://tavya.io/billing', cancelUrl: 'https://tavya.io/billing', idempotencyKey: 'k' });
    expect(api.transactions.at(-1).items).toEqual([{ price_id: 'pri_seat', quantity: 2 }, { price_id: 'pri_pack', quantity: 1 }]);
  });

  it('sets the seat line, keeps the packs, and ends the subscription with its last item', async () => {
    const api = paddle([item('pri_seat', 1), item('pri_pack', 2)]);
    await api.provider.updateAddOnSeats({ subscriptionId: 'sub_1', extraSeats: 3, idempotencyKey: 'k' });
    expect(api.writes.at(-1)).toEqual({ items: [{ price_id: 'pri_pack', quantity: 2 }, { price_id: 'pri_seat', quantity: 3 }],
      proration_billing_mode: 'prorated_next_billing_period' });
    await api.provider.updateStoragePacks({ subscriptionId: 'sub_1', storagePacks: 0, idempotencyKey: 'k' });
    expect(api.writes.at(-1).items).toEqual([{ price_id: 'pri_seat', quantity: 3 }]);
    await api.provider.updateAddOnSeats({ subscriptionId: 'sub_1', extraSeats: 0, idempotencyKey: 'k' });
    expect(api.writes.at(-1)).toEqual({ cancel: { effective_from: 'next_billing_period' } });
    // A seat added back keeps it.
    await api.provider.updateAddOnSeats({ subscriptionId: 'sub_1', extraSeats: 1, idempotencyKey: 'k' });
    expect(api.writes.slice(-2)).toEqual([{ scheduled_change: null },
      { items: [{ price_id: 'pri_seat', quantity: 1 }], proration_billing_mode: 'prorated_next_billing_period' }]);
    expect(await api.provider.reconcileRequest({ kind: 'seats', subscriptionId: 'sub_1', seats: 1 }, 'ref', Date.now()))
      .toEqual({ id: 'sub_1' });
    expect(await api.provider.reconcileRequest({ kind: 'seats', subscriptionId: 'sub_1', seats: 2 }, 'ref', Date.now()))
      .toEqual({ absent: true });
  });

  it('leaves seats on a plan subscription to the plan', async () => {
    const api = paddle([item('pri_team', 1), item('pri_seat', 1)]);
    await expect(api.provider.updateAddOnSeats({ subscriptionId: 'sub_1', extraSeats: 2, idempotencyKey: 'k' }))
      .rejects.toThrow(BillingRequestRejected);
    expect(api.writes).toHaveLength(0);
  });

  it('grants seats beside the gift from signed webhooks', async () => {
    const store = await Store.create(':memory:', { hosted: true });
    const org = await store.createOrganization({ name: 'Paddle seats', ownerUserId: 'owner' });
    const api = paddle([item('pri_seat', 1)]);
    const billing = new SubscriptionBillingService(store, api.provider, true);
    await billing.gift(org.id, 'team', 'user:operator', 'paddle-seat-gift');
    await billing.checkoutPacks(org.id, { seats: 1 }, urls, 'paddle-seat-checkout');
    const raw = Buffer.from(JSON.stringify({ event_id: 'evt_seats', event_type: 'subscription.created', occurred_at: new Date().toISOString(),
      data: { id: 'sub_1', customer_id: 'ctm_1', transaction_id: 'txn_seats', status: 'active', items: [item('pri_seat', 1)],
        current_billing_period: { ends_at: '2026-12-01T00:00:00Z' }, scheduled_change: null } }));
    const ts = Math.floor(Date.now() / 1000);
    await billing.handleWebhook(raw, `ts=${ts};h1=${crypto.createHmac('sha256', config.webhookSecret!).update(`${ts}:`).update(raw).digest('hex')}`);
    expect((await billing.current(org.id)).teamSeats).toMatchObject({ total: 2, gifted: 1, paid: 1 });
    await billing.seats(org.id, 3, 'paddle-seat-more');
    expect(api.writes.at(-1)).toEqual({ items: [{ price_id: 'pri_seat', quantity: 2 }], proration_billing_mode: 'prorated_next_billing_period' });
    await store.close();
  });
});
