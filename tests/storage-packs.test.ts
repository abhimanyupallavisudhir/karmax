import { describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import crypto from 'node:crypto';
import { BillingRequestRejected, PaddleSubscriptionProvider, type PaddleRuntimeConfig } from '../src/billing/paddle.js';
import { FakeSubscriptionProvider, StripeSubscriptionProvider, SubscriptionBillingService,
  type SubscriptionProvider } from '../src/billing/subscriptions.js';
import { STORAGE_PACK } from '../src/domain/entitlements.js';
import { managedStorageLocationId } from '../src/store/storage-locations.js';
import { Store } from '../src/store/db.js';

const GIB = 1024 ** 3;
const urls = { success: 'https://tavya.test/success', cancel: 'https://tavya.test/cancel' };
const event = (id: string, type: string, object: any, created: number) =>
  Buffer.from(JSON.stringify({ id, type, created, data: { object } }));

/** An organization whose Team (or Individual) subscription was verified
 * through the stub provider, with `packs` storage packs on it. */
async function subscribed(plan: 'individual' | 'team' = 'team', packs = 0, location = ':memory:') {
  const store = await Store.create(location, { hosted: true });
  const organization = await store.createOrganization({ name: `Packs ${crypto.randomUUID().slice(0, 8)}`, ownerUserId: 'owner' });
  const provider = new FakeSubscriptionProvider();
  const billing = new SubscriptionBillingService(store, provider, true);
  await billing.checkout(organization.id, plan, urls, `checkout-${organization.id}`);
  let clock = 100;
  const snapshot = (status: string, count = packs) => ({
    id: 'sub_packs', customer: `cus_${organization.id}`, status, items: { data: [
      { id: 'si_base', price: { id: plan === 'team' ? 'price_team_base' : 'price_individual' }, quantity: 1 },
      ...(count ? [{ id: 'si_pack', price: { id: 'price_storage_pack' }, quantity: count }] : []),
    ] } });
  const deliver = (type: string, object: any) => billing.handleWebhook(event(`evt_${++clock}`, type, object, clock));
  const update = (status: string, count = packs) => deliver('customer.subscription.updated', snapshot(status, count));
  await update('active');
  const granted = async () => (await store.organizationEntitlements(organization.id)).storagePacks;
  return { store, organization, provider, billing, snapshot, deliver, update, granted };
}

async function storeBytes(store: Store, organizationId: string, bytes: number) {
  const id = managedStorageLocationId(organizationId);
  if (!await store.getStorageLocation(id)) await store.saveStorageLocation({ id, organizationId, name: 'Managed storage',
    kind: 'managed', config: {}, isDefault: true, status: 'ready', createdAt: Date.now(), updatedAt: Date.now() });
  await store.db.prepare(`INSERT INTO resource_snapshot_chunks (organizationId, chunkId, storageLocationId, refs, bytes)
    VALUES (?, ?, ?, 1, ?)`).run(organizationId, crypto.randomUUID(), id, bytes);
}

describe('storage packs from verified subscription state', () => {
  it('grants the verified pack quantity while access is active or in grace, and none once it lapses', async () => {
    const f = await subscribed('team', 2);
    expect(await f.billing.current(f.organization.id)).toMatchObject({ storagePacks: 2,
      storagePack: { bytes: STORAGE_PACK.bytes, monthlyPriceCents: 400, available: true } });
    expect(await f.store.organizationEntitlements(f.organization.id)).toMatchObject({ storagePacks: 2, storageQuotaBytes: 300 * GIB });

    await f.deliver('invoice.payment_failed', { id: 'in_1', customer: `cus_${f.organization.id}`, subscription: 'sub_packs' });
    const { graceEndsAt } = await f.billing.current(f.organization.id);
    expect(await f.granted()).toBe(2);
    await f.billing.reconcileEntitlements(graceEndsAt! + 1);
    expect(await f.store.organizationEntitlements(f.organization.id)).toMatchObject({ plan: 'free', storagePacks: 0, storageQuotaBytes: 5 * GIB });
    await f.deliver('invoice.paid', { id: 'in_1', customer: `cus_${f.organization.id}`, subscription: 'sub_packs' });
    expect(await f.granted()).toBe(2);

    for (const status of ['unpaid', 'paused', 'incomplete']) {
      await f.update(status);
      expect(await f.granted(), status).toBe(0);
      await f.update('active');
      expect(await f.granted()).toBe(2);
    }
    await f.update('active', 3);
    expect(await f.granted()).toBe(3);
    await f.deliver('customer.subscription.deleted', f.snapshot('canceled', 3));
    expect(await f.granted()).toBe(0);
    expect(await f.billing.current(f.organization.id)).toMatchObject({ status: 'canceled', storagePacks: 0 });
    await f.store.close();
  });

  it('never grants packs from a gift', async () => {
    const f = await subscribed('individual', 1);
    await f.billing.gift(f.organization.id, 'team', 'user:operator', 'gift-with-paid-packs');
    expect(await f.store.organizationEntitlements(f.organization.id)).toMatchObject({ plan: 'team', storagePacks: 1 });
    await f.deliver('customer.subscription.deleted', f.snapshot('canceled'));
    expect(await f.store.organizationEntitlements(f.organization.id)).toMatchObject({ plan: 'team', storagePacks: 0, storageQuotaBytes: 100 * GIB });
    await f.store.close();
  });

  it('refuses duplicate pack items rather than guessing a quantity', async () => {
    const f = await subscribed('team');
    const object = f.snapshot('active', 1);
    object.items.data.push({ id: 'si_pack_2', price: { id: 'price_storage_pack' }, quantity: 1 });
    await expect(f.deliver('customer.subscription.updated', object)).rejects.toThrow(/duplicate storage pack/);
    expect(await f.granted()).toBe(0);
    await f.store.close();
  });
});

const postgres = process.env.KARMAX_TEST_POSTGRES_URL;
(postgres ? describe : describe.skip)('storage packs on PostgreSQL', () => {
  it('persists verified packs and adds the column to an existing billing table', async () => {
    const admin = new Pool({ connectionString: postgres });
    try {
      await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
      let f = await subscribed('team', 2, postgres);
      expect(await f.billing.current(f.organization.id)).toMatchObject({ storagePacks: 2 });
      await f.store.close();
      await admin.query('ALTER TABLE subscription_billing_accounts DROP COLUMN "storagePacks"');
      const store = await Store.create(postgres!, { hosted: true });
      expect(await new SubscriptionBillingService(store, new FakeSubscriptionProvider(), true).current(f.organization.id))
        .toMatchObject({ plan: 'team', storagePacks: 0 });
      await store.close();
      await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
      f = await subscribed('individual', 1, postgres);
      expect(await f.granted()).toBe(1);
      await f.store.close();
    } finally {
      await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
      await admin.end();
    }
  });
});

describe('changing storage packs', () => {
  it('asks the provider for the new quantity and waits for verified state before granting it', async () => {
    const f = await subscribed('team', 1);
    expect(await f.billing.storagePacks(f.organization.id, 3, 'packs-to-three')).toEqual({ id: 'sub_packs' });
    expect(f.provider.calls.at(-1)).toMatchObject({ method: 'updateStoragePacks',
      input: { subscriptionId: 'sub_packs', storagePacks: 3 } });
    expect(await f.granted()).toBe(1);
    await f.billing.storagePacks(f.organization.id, 3, 'packs-to-three');
    expect(f.provider.calls.filter((call) => call.method === 'updateStoragePacks')).toHaveLength(1);
    await expect(f.billing.storagePacks(f.organization.id, 2, 'packs-to-three')).rejects.toThrow(/idempotency key/);
    await f.store.close();
  });

  it('accepts only a whole, non-negative pack count from an owner request with a key', async () => {
    const f = await subscribed('team');
    for (const packs of [-1, 1.5, '2', null, Number.MAX_SAFE_INTEGER + 1])
      await expect(f.billing.storagePacks(f.organization.id, packs, `bad-packs-${String(packs)}`)).rejects.toThrow(/whole number/);
    await expect(f.billing.storagePacks(f.organization.id, 1, '')).rejects.toThrow(/Idempotency-Key/);
    expect(f.provider.calls.filter((call) => call.method === 'updateStoragePacks')).toHaveLength(0);
    await f.store.close();
  });

  it('needs a live paid subscription and a configured pack price', async () => {
    const store = await Store.create(':memory:', { hosted: true });
    const organization = await store.createOrganization({ name: 'Free', ownerUserId: 'owner' });
    const billing = new SubscriptionBillingService(store, new FakeSubscriptionProvider(), true);
    await expect(billing.storagePacks(organization.id, 1, 'free-packs')).rejects.toThrow(/paid subscription/);
    await billing.gift(organization.id, 'team', 'user:operator', 'gift-no-packs');
    await expect(billing.storagePacks(organization.id, 1, 'gift-packs')).rejects.toThrow(/paid subscription/);
    await store.close();

    const f = await subscribed('team');
    await f.update('canceled');
    await expect(f.billing.storagePacks(f.organization.id, 1, 'canceled-packs')).rejects.toThrow(/paid subscription/);
    await f.store.close();

    const unpriced = await subscribed('team');
    vi.spyOn(unpriced.provider, 'catalog').mockReturnValue({ individualPriceId: 'price_individual',
      teamBasePriceId: 'price_team_base', teamSeatPriceId: 'price_team_seat' });
    await expect(unpriced.billing.storagePacks(unpriced.organization.id, 1, 'unpriced-packs')).rejects.toThrow(/not available/);
    expect((await unpriced.billing.current(unpriced.organization.id)).storagePack?.available).toBe(false);
    await unpriced.store.close();

    const local = await Store.create(':memory:');
    await expect(new SubscriptionBillingService(local, new FakeSubscriptionProvider(), false)
      .storagePacks('org_personal', 1, 'self-hosted-packs')).rejects.toThrow(/self-hosted/);
    await local.close();
  });

  it('adds no packs while a payment is failing, but still lets the owner remove them', async () => {
    const f = await subscribed('team', 2);
    await f.deliver('invoice.payment_failed', { id: 'in_1', customer: `cus_${f.organization.id}`, subscription: 'sub_packs' });
    await expect(f.billing.storagePacks(f.organization.id, 3, 'past-due-add')).rejects.toThrow(/payment method/);
    await f.billing.storagePacks(f.organization.id, 1, 'past-due-remove');
    expect(f.provider.calls.at(-1)).toMatchObject({ method: 'updateStoragePacks', input: { storagePacks: 1 } });
    await f.store.close();
  });

  it('refuses to remove packs the stored data still needs, and says how much to free', async () => {
    const f = await subscribed('team', 2);
    await storeBytes(f.store, f.organization.id, 250 * GIB);
    await expect(f.billing.storagePacks(f.organization.id, 1, 'remove-too-much'))
      .rejects.toThrow(/Free 50 GB of stored data first/);
    await expect(f.billing.storagePacks(f.organization.id, 0, 'remove-all')).rejects.toThrow(/Free 150 GB/);
    expect(f.provider.calls.filter((call) => call.method === 'updateStoragePacks')).toHaveLength(0);
    // Adding is never blocked by stored data.
    await f.billing.storagePacks(f.organization.id, 4, 'add-while-full');
    await f.store.close();

    const room = await subscribed('team', 2);
    await storeBytes(room.store, room.organization.id, 150 * GIB);
    await room.billing.storagePacks(room.organization.id, 1, 'remove-with-room');
    expect(room.provider.calls.at(-1)).toMatchObject({ method: 'updateStoragePacks', input: { storagePacks: 1 } });
    await room.store.close();
  });
});

const config: PaddleRuntimeConfig = { environment: 'sandbox', apiKey: 'pdl_sdbx_apikey_test',
  webhookSecret: 'pdl_ntfset_test', clientToken: 'test_token', individualPriceId: 'pri_individual',
  teamBasePriceId: 'pri_team', teamSeatPriceId: 'pri_seat', storagePackPriceId: 'pri_pack', storagePackProductId: 'pro_pack' };
const item = (price: string, quantity: number, product = price === 'pri_pack' ? 'pro_pack' : 'pro_plan') =>
  ({ price: { id: price, product_id: product }, quantity });
const signed = (value: unknown) => {
  const raw = Buffer.from(JSON.stringify(value));
  const timestamp = Math.floor(Date.now() / 1000);
  return { raw, signature: `ts=${timestamp};h1=${crypto.createHmac('sha256', config.webhookSecret!).update(`${timestamp}:`).update(raw).digest('hex')}` };
};

/** A Paddle API holding one subscription; PATCH replaces its items, as Paddle does. */
function paddle(items: any[], overrides: Partial<PaddleRuntimeConfig> = {}) {
  const subscription = { id: 'sub_1', status: 'active', customer_id: 'ctm_1', items };
  const writes: any[] = [];
  let lose = false;
  const fetcher = vi.fn(async (url: any, init: any) => {
    const path = new URL(String(url)).pathname;
    if (init.method === 'POST' && path === '/transactions') return Response.json({ data: { id: 'txn_packs' } });
    if (path !== '/subscriptions/sub_1') return Response.json({ error: { code: 'not_found' } }, { status: 404 });
    if (init.method === 'PATCH') {
      const body = JSON.parse(init.body);
      writes.push(body);
      subscription.items = body.items.map((i: any) => item(i.price_id, i.quantity));
      if (lose) throw new Error('connection reset');
    }
    return Response.json({ data: subscription });
  });
  const provider = new PaddleSubscriptionProvider(() => ({ ...config, ...overrides }), fetcher as any);
  return { provider, writes, subscription, fetcher, loseResponses: () => { lose = true; } };
}

describe('Paddle storage pack items', () => {
  it('sets the pack quantity and sends every item the subscription keeps', async () => {
    const api = paddle([item('pri_team', 1), item('pri_seat', 2)]);
    await api.provider.updateStoragePacks({ subscriptionId: 'sub_1', storagePacks: 3, idempotencyKey: 'k' });
    expect(api.writes.at(-1)).toEqual({ items: [{ price_id: 'pri_team', quantity: 1 }, { price_id: 'pri_seat', quantity: 2 },
      { price_id: 'pri_pack', quantity: 3 }], proration_billing_mode: 'prorated_next_billing_period' });
    await api.provider.updateStoragePacks({ subscriptionId: 'sub_1', storagePacks: 1, idempotencyKey: 'k' });
    expect(api.writes.at(-1).items).toEqual([{ price_id: 'pri_team', quantity: 1 }, { price_id: 'pri_seat', quantity: 2 },
      { price_id: 'pri_pack', quantity: 1 }]);
    // Paddle has no zero quantity: the last pack removes the item.
    await api.provider.updateStoragePacks({ subscriptionId: 'sub_1', storagePacks: 0, idempotencyKey: 'k' });
    expect(api.writes.at(-1).items).toEqual([{ price_id: 'pri_team', quantity: 1 }, { price_id: 'pri_seat', quantity: 2 }]);
    await api.provider.updateStoragePacks({ subscriptionId: 'sub_1', storagePacks: 0, idempotencyKey: 'k' });
    expect(api.writes).toHaveLength(3);

    const individual = paddle([item('pri_individual', 1)]);
    await individual.provider.updateStoragePacks({ subscriptionId: 'sub_1', storagePacks: 2, idempotencyKey: 'k' });
    expect(individual.writes.at(-1).items).toEqual([{ price_id: 'pri_individual', quantity: 1 }, { price_id: 'pri_pack', quantity: 2 }]);
  });

  it('refuses subscriptions it cannot rewrite safely', async () => {
    const reject = (items: any[], overrides: Partial<PaddleRuntimeConfig> = {}) =>
      paddle(items, overrides).provider.updateStoragePacks({ subscriptionId: 'sub_1', storagePacks: 1, idempotencyKey: 'k' });
    await expect(reject([item('pri_team', 1)], { storagePackPriceId: undefined }))
      .rejects.toThrow(new BillingRequestRejected('storage packs are not configured'));
    await expect(reject([item('pri_seat', 2)])).rejects.toThrow(new BillingRequestRejected('cannot add storage packs to a Paddle subscription without a plan'));
    await expect(reject([item('pri_team', 1), item('pri_other', 1)]))
      .rejects.toThrow(new BillingRequestRejected('Paddle subscription has unexpected items; reconcile before changing storage packs'));
    const invalid = paddle([item('pri_team', 1)]);
    for (const storagePacks of [-1, 0.5]) await expect(invalid.provider.updateStoragePacks({ subscriptionId: 'sub_1', storagePacks, idempotencyKey: 'k' }))
      .rejects.toThrow(new BillingRequestRejected('invalid storage pack count'));
    expect(invalid.writes).toHaveLength(0);
  });

  it('keeps the pack item through plan changes and seat updates', async () => {
    const change = paddle([item('pri_team', 1), item('pri_seat', 2), item('pri_pack', 2)]);
    await change.provider.changePlan({ subscriptionId: 'sub_1', plan: 'individual', seats: 1, items: {}, idempotencyKey: 'k' });
    expect(change.writes.at(-1)).toEqual({ items: [{ price_id: 'pri_individual', quantity: 1 }, { price_id: 'pri_pack', quantity: 2 }],
      proration_billing_mode: 'prorated_next_billing_period' });
    await change.provider.changePlan({ subscriptionId: 'sub_1', plan: 'individual', seats: 1, items: {}, idempotencyKey: 'k' });
    expect(change.writes).toHaveLength(1);

    const seats = paddle([item('pri_team', 1), item('pri_seat', 2), item('pri_pack', 1)]);
    await seats.provider.updateSeats({ subscriptionId: 'sub_1', seats: 5, idempotencyKey: 'k' });
    expect(seats.writes.at(-1)).toEqual({ items: [{ price_id: 'pri_team', quantity: 1 }, { price_id: 'pri_seat', quantity: 4 },
      { price_id: 'pri_pack', quantity: 1 }], proration_billing_mode: 'prorated_next_billing_period' });
    await seats.provider.updateSeats({ subscriptionId: 'sub_1', seats: 1, idempotencyKey: 'k' });
    expect(seats.writes.at(-1).items).toEqual([{ price_id: 'pri_team', quantity: 1 }, { price_id: 'pri_pack', quantity: 1 }]);
  });

  it('reconciles a pack write by the pack quantity alone, and plan writes regardless of packs', async () => {
    const api = paddle([item('pri_team', 1), item('pri_seat', 2), item('pri_pack', 2)]);
    const reconcile = (intent: any) => api.provider.reconcileRequest(intent, 'ref', Date.now());
    expect(await reconcile({ kind: 'storage', subscriptionId: 'sub_1', storagePacks: 2 })).toEqual({ id: 'sub_1' });
    expect(await reconcile({ kind: 'storage', subscriptionId: 'sub_1', storagePacks: 3 })).toEqual({ absent: true });
    expect(await reconcile({ kind: 'storage', subscriptionId: 'sub_1' })).toBeNull();
    expect(await reconcile({ kind: 'seats', subscriptionId: 'sub_1', plan: 'team', seats: 3 })).toEqual({ id: 'sub_1' });
    expect(await reconcile({ kind: 'change', subscriptionId: 'sub_1', plan: 'individual', seats: 1 })).toEqual({ absent: true });
  });

  it('carries pack items from signed webhooks into the verified pack count', async () => {
    const store = await Store.create(':memory:', { hosted: true });
    const organization = await store.createOrganization({ name: 'Paddle packs', ownerUserId: 'owner' });
    const api = paddle([item('pri_team', 1)]);
    const billing = new SubscriptionBillingService(store, api.provider, true);
    await billing.checkout(organization.id, 'team', urls, 'paddle-pack-checkout');
    const snapshot = (id: string, at: string, items: any[], status = 'active') => signed({ event_id: id,
      event_type: id === 'evt_created' ? 'subscription.created' : 'subscription.updated', occurred_at: at,
      data: { id: 'sub_1', customer_id: 'ctm_1', transaction_id: 'txn_packs', status, items,
        current_billing_period: { ends_at: '2026-11-01T00:00:00Z' }, scheduled_change: null } });
    let delivery = snapshot('evt_created', '2026-10-01T00:00:00Z', [item('pri_team', 1), item('pri_pack', 2)]);
    await billing.handleWebhook(delivery.raw, delivery.signature);
    expect(await billing.current(organization.id)).toMatchObject({ plan: 'team', storagePacks: 2 });
    expect(await store.organizationEntitlements(organization.id)).toMatchObject({ storagePacks: 2, storageQuotaBytes: 300 * GIB });
    // A pack price on someone else's product is not ours to count.
    delivery = snapshot('evt_foreign', '2026-10-01T00:01:00Z', [item('pri_team', 1), item('pri_pack', 2, 'pro_other')]);
    await expect(billing.handleWebhook(delivery.raw, delivery.signature)).rejects.toThrow(/unexpected product/);
    delivery = snapshot('evt_lapsed', '2026-10-01T00:02:00Z', [item('pri_team', 1), item('pri_pack', 2)], 'paused');
    await billing.handleWebhook(delivery.raw, delivery.signature);
    expect(await store.organizationEntitlements(organization.id)).toMatchObject({ plan: 'free', storagePacks: 0 });
    await store.close();
  });

  it('reserves an uncertain pack write, never resends it, and settles it by reading Paddle', async () => {
    const store = await Store.create(':memory:', { hosted: true });
    const organization = await store.createOrganization({ name: 'Uncertain packs', ownerUserId: 'owner' });
    const api = paddle([item('pri_team', 1)]);
    const billing = new SubscriptionBillingService(store, api.provider, true);
    await billing.checkout(organization.id, 'team', urls, 'paddle-uncertain-checkout');
    const created = signed({ event_id: 'evt_created', event_type: 'subscription.created', occurred_at: new Date().toISOString(),
      data: { id: 'sub_1', customer_id: 'ctm_1', transaction_id: 'txn_packs', status: 'active', items: [item('pri_team', 1)] } });
    await billing.handleWebhook(created.raw, created.signature);

    api.loseResponses();
    await expect(billing.storagePacks(organization.id, 2, 'uncertain-packs-1')).rejects.toThrow('connection reset');
    await expect(billing.storagePacks(organization.id, 2, 'uncertain-packs-1')).rejects.toThrow(/reconciliation/);
    await expect(billing.storagePacks(organization.id, 2, 'uncertain-packs-2')).rejects.toThrow(/reconcil|progress/);
    expect(api.writes).toHaveLength(1);
    expect(await billing.current(organization.id)).toMatchObject({ pendingRequest: true, storagePacks: 0 });
    const lock = await store.db.prepare('SELECT intentJson FROM subscription_billing_locks WHERE organizationId=?').get(organization.id) as any;
    expect(JSON.parse(lock.intentJson)).toEqual({ kind: 'storage', subscriptionId: 'sub_1', storagePacks: 2 });

    await store.db.prepare('UPDATE subscription_billing_locks SET createdAt=? WHERE organizationId=?').run(Date.now() - 120_000, organization.id);
    expect(await billing.reconcilePending(organization.id)).toEqual({ reconciled: true, pending: false, applied: true });
    expect(await billing.storagePacks(organization.id, 2, 'uncertain-packs-1')).toEqual({ id: 'sub_1' });
    expect(api.writes).toHaveLength(1);
    // Reading Paddle settles the request; only the signed webhook grants the packs.
    expect(await store.organizationEntitlements(organization.id)).toMatchObject({ storagePacks: 0 });
    await store.close();
  });

  it('is refused by the legacy Stripe adapter', async () => {
    const stripe: SubscriptionProvider = new StripeSubscriptionProvider({}, vi.fn() as any);
    await expect(stripe.updateStoragePacks({ subscriptionId: 'sub_1', storagePacks: 1, idempotencyKey: 'k' }))
      .rejects.toThrow(new BillingRequestRejected('storage packs are billed only through Paddle'));
  });
});
