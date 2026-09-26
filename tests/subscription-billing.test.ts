import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store/db.js';
import { FakeSubscriptionProvider, StripeSubscriptionProvider,
  PAST_DUE_GRACE_MS, SubscriptionBillingService } from '../src/billing/subscriptions.js';
import { STRIPE_BILLING_API_VERSION } from '../src/billing/stripe-contract.js';
import { Gateway } from '../src/gateway/server.js';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { AuthorizationService } from '../src/platform/authorization.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { WorldRegistry } from '../src/world/registry.js';
import { findFreePortFrom } from '../src/util/ports.js';
import { POLICY_VERSION, policyVersions } from '../src/launch/legal.js';

const event = (id: string, type: string, object: any, created = 100) =>
  Buffer.from(JSON.stringify({ id, type, created, data: { object } }));

describe('hosted subscription billing', () => {
  it('continues reconciling subscriptions sold under a retired price', async () => {
    const store = await Store.create(':memory:', { hosted: true });
    try {
      const org = await store.createOrganization({ name: 'Grandfathered', ownerUserId: 'owner' });
      const catalog = { individualPriceId: 'price_old', teamBasePriceId: 'price_team', teamSeatPriceId: 'price_seat' };
      const provider = new FakeSubscriptionProvider(catalog);
      const billing = new SubscriptionBillingService(store, provider, true);
      await billing.checkout(org.id, 'individual', { success: 'https://test/s', cancel: 'https://test/c' }, 'old-price-checkout');
      catalog.individualPriceId = 'price_new';
      await billing.handleWebhook(event('old-price-active', 'customer.subscription.updated', {
        id: 'sub_old', customer: `cus_${org.id}`, status: 'active',
        items: { data: [{ id: 'si_old', price: 'price_old', quantity: 1 }] },
      }));
      expect(await billing.current(org.id)).toMatchObject({ plan: 'individual', status: 'active' });
    } finally { await store.close(); }
  });

  it('persists complimentary plans without Stripe and restores paid access after removal', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-gifts-'));
    const database = path.join(directory, 'billing.db');
    let store = await Store.create(database, { hosted: true });
    const organization = await store.createOrganization({ name: 'Gift recipient', ownerUserId: 'owner' });
    const provider = new FakeSubscriptionProvider();
    let billing = new SubscriptionBillingService(store, provider, true);
    try {
      vi.spyOn(provider, 'configured').mockReturnValue(false);
      await billing.gift(organization.id, 'team', 'user:god', 'gift-team-1');
      expect(await billing.current(organization.id)).toMatchObject({ plan: 'team', access: 'active',
        gift: { plan: 'team', grantedBy: 'user:god' }, seatDeficit: 0 });
      expect((await store.organizationEntitlements(organization.id)).maxActiveAgentRuns).toBe(20);
      expect(provider.calls).toHaveLength(0);
      await store.close();
      store = await Store.create(database, { hosted: true });
      billing = new SubscriptionBillingService(store, provider, true);
      await billing.reconcileEntitlements();
      expect((await billing.current(organization.id)).plan).toBe('team');
      await billing.gift(organization.id, 'individual', 'user:god', 'gift-individual-1');
      // A retried older gift must not overwrite a newer selection.
      await billing.gift(organization.id, 'team', 'user:god', 'gift-team-1');
      expect((await billing.current(organization.id)).plan).toBe('individual');
      await expect(billing.gift(organization.id, 'enterprise', 'user:god', 'gift-invalid-1')).rejects.toThrow(/Individual or Team/);
      await expect(billing.gift(organization.id, 'free', 'user:god', 'gift-invalid-2')).rejects.toThrow(/Individual or Team/);
      await expect(billing.gift('missing', 'team', 'user:god', 'gift-missing-1')).rejects.toThrow(/organization/);
      await expect(billing.gift(organization.id, 'team', 'user:god', '')).rejects.toThrow(/Idempotency/);
      vi.mocked(provider.configured).mockReturnValue(true);
      await billing.checkout(organization.id, 'individual', { success: 'https://test/s', cancel: 'https://test/c' }, 'gift-checkout-1');
      await billing.handleWebhook(event('gift-paid', 'customer.subscription.updated', {
        id: 'sub_gift', customer: `cus_${organization.id}`, status: 'active',
        items: { data: [{ id: 'si', price: { id: 'price_individual' }, quantity: 1 }] },
      }));
      await billing.gift(organization.id, 'team', 'user:god', 'gift-team-2');
      await billing.reconcileEntitlements();
      expect(await billing.current(organization.id)).toMatchObject({ plan: 'team', billedPlan: 'individual' });
      await billing.gift(organization.id, null, 'user:god', 'gift-remove-1');
      expect(await billing.current(organization.id)).toMatchObject({ plan: 'individual', gift: null });
      await billing.gift(organization.id, 'team', 'user:god', 'gift-team-3');
      await billing.handleWebhook(event('gift-canceled', 'customer.subscription.deleted', {
        id: 'sub_gift', customer: `cus_${organization.id}`,
      }, 101));
      expect((await billing.current(organization.id)).plan).toBe('team');
      await billing.gift(organization.id, null, 'user:god', 'gift-remove-2');
      expect((await billing.current(organization.id)).plan).toBe('free');
    } finally {
      await store.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps better paid access, includes gifts in exports, and cleans them up on deletion', async () => {
    const store = await Store.create(':memory:', { hosted: true });
    const organization = await store.createOrganization({ name: 'Paid team', ownerUserId: 'owner' });
    const provider = new FakeSubscriptionProvider();
    const billing = new SubscriptionBillingService(store, provider, true);
    try {
      await billing.checkout(organization.id, 'team', { success: 'https://test/s', cancel: 'https://test/c' }, 'paid-team-checkout');
      await billing.handleWebhook(event('paid-team-active', 'customer.subscription.updated', {
        id: 'sub_team', customer: `cus_${organization.id}`, status: 'active',
        items: { data: [{ id: 'si_team', price: { id: 'price_team_base' }, quantity: 1 }] },
      }));
      await billing.gift(organization.id, 'individual', 'user:god', 'paid-team-gift');
      expect(await billing.current(organization.id)).toMatchObject({ plan: 'team', gift: { plan: 'individual' } });
      expect((await store.exportOrganization(organization.id)).tables).toMatchObject({
        subscription_gifts: [{ organizationId: organization.id, plan: 'individual', grantedBy: 'user:god', grantedAt: expect.any(Number) }],
      });
      await expect(billing.gift(organization.id, null, 'user:god', 'paid-team-gift')).rejects.toThrow(/already used/);
      const privateBilling = new SubscriptionBillingService(store, provider, false);
      await expect(privateBilling.gift(organization.id, 'team', 'user:god', 'private-gift')).rejects.toThrow(/hosted/);
      await store.deleteOrganization(organization.id);
      expect(await billing.currentGift(organization.id)).toBeNull();
    } finally { await store.close(); }
  });

  it('reconciles equal-second lifecycle collisions deterministically', async () => {
    const reconcile = async (deliveries: Array<'active' | 'deleted' | 'paid' | 'failed'>) => {
      const store = (await Store.create(':memory:', { hosted: true }));
      const organization = (await store.createOrganization({ name: `Collision ${deliveries.join('-')}`, ownerUserId: 'owner' }));
      const billing = new SubscriptionBillingService(store, new FakeSubscriptionProvider(), true);
      await billing.checkout(organization.id, 'team',
        { success: 'https://krmax.test/success', cancel: 'https://krmax.test/cancel' },
        `checkout-${deliveries.join('-')}`);
      const subscription = { id: `sub_${organization.id}`, customer: `cus_${organization.id}`,
        status: 'active', items: { data: [
          { id: 'si_base', price: { id: 'price_team_base' }, quantity: 1 },
        ] } };
      if (deliveries.includes('paid') || deliveries.includes('failed'))
        (await billing.handleWebhook(event('evt_seed', 'customer.subscription.updated', subscription, 90)));
      for (const [index, delivery] of deliveries.entries()) {
        if (delivery === 'active')
          (await billing.handleWebhook(event(`evt_active_${index}`, 'customer.subscription.updated', subscription, 100)));
        else if (delivery === 'deleted')
          (await billing.handleWebhook(event(`evt_deleted_${index}`, 'customer.subscription.deleted', subscription, 100)));
        else (await billing.handleWebhook(event(`evt_invoice_${delivery}_${index}`,
          delivery === 'paid' ? 'invoice.paid' : 'invoice.payment_failed',
          { id: 'in_collision', customer: `cus_${organization.id}`, subscription: subscription.id }, 100)));
      }
      const state = (await billing.current(organization.id));
      (await store.close());
      return state;
    };

    // Deletion is sticky and payment recovery outranks failure for the same
    // provider second, regardless of network delivery order.
    await expect(reconcile(['active', 'deleted'])).resolves.toMatchObject({ plan: 'free', status: 'canceled' });
    await expect(reconcile(['deleted', 'active'])).resolves.toMatchObject({ plan: 'free', status: 'canceled' });
    await expect(reconcile(['paid', 'failed'])).resolves.toMatchObject({ plan: 'team', status: 'active' });
    await expect(reconcile(['failed', 'paid'])).resolves.toMatchObject({ plan: 'team', status: 'active' });

    const database = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-billing-order-')), 'billing.db');
    let durableStore = (await Store.create(database, { hosted: true }));
    const durableOrganization = (await durableStore.createOrganization({ name: 'Durable collision', ownerUserId: 'owner' }));
    let durableBilling = new SubscriptionBillingService(durableStore, new FakeSubscriptionProvider(), true);
    await durableBilling.checkout(durableOrganization.id, 'team',
      { success: 'https://krmax.test/success', cancel: 'https://krmax.test/cancel' }, 'checkout-durable-order');
    const durableSubscription = { id: 'sub_durable', customer: `cus_${durableOrganization.id}`, status: 'active',
      items: { data: [{ id: 'si_base', price: { id: 'price_team_base' }, quantity: 1 }] } };
    (await durableBilling.handleWebhook(event('evt_durable_deleted', 'customer.subscription.deleted', durableSubscription, 100)));
    (await durableStore.close());
    durableStore = (await Store.create(database, { hosted: true }));
    durableBilling = new SubscriptionBillingService(durableStore, new FakeSubscriptionProvider(), true);
    (await durableBilling.handleWebhook(event('evt_durable_active', 'customer.subscription.updated', durableSubscription, 100)));
    expect((await durableBilling.current(durableOrganization.id))).toMatchObject({ plan: 'free', status: 'canceled' });
    (await durableStore.close());
  });

  it('derives plan and seats only from verified provider events and reconciles failures idempotently', async () => {
    const store = (await Store.create(':memory:', { hosted: true }));
    const organization = (await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' }));
    const provider = new FakeSubscriptionProvider();
    const billing = new SubscriptionBillingService(store, provider, true);
    await (async () => (await billing.assertOrganizationDeletionAllowed(organization.id)))();

    const checkout = await billing.checkout(organization.id, 'team',
      { success: 'https://krmax.test/success', cancel: 'https://krmax.test/cancel' }, 'checkout-request-1');
    expect(checkout).toMatchObject({
      organizationId: organization.id, plan: 'team', url: 'https://checkout.test/session',
      checkoutRequestReference: 'checkout-request-1',
      checkoutSessionReference: 'cs_test', checkoutProvider: 'fake-billing',
      commercialTerms: {
        planId: 'team', planName: 'Team', currency: 'usd', billingInterval: 'month',
        monthlyBasePriceCents: 1_900, includedActiveUsers: 1,
        monthlyAdditionalActiveUserPriceCents: 500, activeUsers: 1,
        monthlyTotalPriceCents: 1_900,
      },
    });
    // A checkout response is not an entitlement claim. Until the signed
    // subscription event arrives, the organization is still Free.
    expect((await billing.current(organization.id))).toMatchObject({ plan: 'free', status: 'none', seats: 1 });
    expect((await store.getOrganization(organization.id))?.plan).toBe('free');
    expect(await billing.checkout(organization.id, 'team',
      { success: 'https://ignored.test', cancel: 'https://ignored.test' }, 'checkout-request-1')).toEqual(checkout);
    expect(provider.calls.filter((call) => call.method === 'createCheckout')).toHaveLength(1);

    const subscription = {
      id: 'sub_acme', customer: `cus_${organization.id}`, status: 'active', current_period_end: 2_000,
      cancel_at_period_end: false, items: { data: [
        { id: 'si_base', price: { id: 'price_team_base', product: 'prod_team' }, quantity: 1 },
        { id: 'si_seat', price: { id: 'price_team_seat', product: 'prod_team' }, quantity: 2 },
      ] },
    };
    // Checkout completion can be delivered before the older subscription
    // snapshot. It associates IDs but must not suppress that authoritative plan.
    (await billing.handleWebhook(event('evt_checkout', 'checkout.session.completed', {
      id: 'cs_test', customer: `cus_${organization.id}`, subscription: 'sub_acme',
    }, 110)));
    await expect((async () => (await billing.assertOrganizationDeletionAllowed(organization.id)))()).rejects.toThrow('provider subscription is none');
    expect((await billing.handleWebhook(event('evt_1', 'customer.subscription.updated', subscription)))).toEqual({ duplicate: false });
    expect((await billing.current(organization.id))).toMatchObject({ plan: 'team', status: 'active', seats: 3,
      activeUsers: 1, seatDeficit: 0, access: 'active' });
    expect((await store.getOrganization(organization.id))?.plan).toBe('team');
    expect((await billing.handleWebhook(event('evt_1', 'customer.subscription.updated', subscription)))).toEqual({ duplicate: true });

    (await billing.handleWebhook(event('evt_fail', 'invoice.payment_failed', {
      id: 'in_1', customer: `cus_${organization.id}`, subscription: 'sub_acme',
    }, 110)));
    expect((await billing.current(organization.id))).toMatchObject({ plan: 'team', status: 'past_due', access: 'grace',
      lastError: 'The latest subscription payment failed.' });
    (await billing.handleWebhook(event('evt_paid', 'invoice.paid', {
      id: 'in_1', customer: `cus_${organization.id}`, subscription: 'sub_acme',
    }, 120)));
    expect((await billing.current(organization.id))).toMatchObject({ plan: 'team', status: 'active', access: 'active' });

    // An older delivery is recorded but cannot roll current state backward.
    (await billing.handleWebhook(event('evt_old', 'invoice.payment_failed', {
      id: 'in_old', customer: `cus_${organization.id}`, subscription: 'sub_acme',
    }, 105)));
    expect((await billing.current(organization.id)).status).toBe('active');
  });

  it('keeps server customer mappings as the tenant boundary and synchronizes active Team users', async () => {
    const store = (await Store.create(':memory:', { hosted: true }));
    const organization = (await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' }));
    const other = (await store.createOrganization({ name: 'Other', ownerUserId: 'other-owner' }));
    const provider = new FakeSubscriptionProvider();
    const billing = new SubscriptionBillingService(store, provider, true);
    await billing.checkout(organization.id, 'team',
      { success: 'https://krmax.test/success', cancel: 'https://krmax.test/cancel' }, 'checkout-request-2');

    // A signed event with attacker-controlled metadata is ignored unless its
    // customer/subscription was first mapped by the server.
    (await billing.handleWebhook(event('evt_foreign', 'customer.subscription.updated', {
      id: 'sub_foreign', customer: 'cus_foreign', status: 'active',
      metadata: { karmax_organization_id: other.id },
      items: { data: [{ id: 'si_ind', price: { id: 'price_individual' }, quantity: 1 }] },
    })));
    expect((await billing.current(other.id)).plan).toBe('free');

    const retryId = 'evt_retry_after_reconciliation_error';
    await expect((async () => (await billing.handleWebhook(event(retryId, 'customer.subscription.updated', {
      id: 'sub_acme', customer: `cus_${organization.id}`, status: 'active',
      items: { data: [{ id: 'si_unknown', price: { id: 'price_unknown' }, quantity: 1 }] },
    }, 101))))()).rejects.toThrow('no configured Karmax plan price');
    expect((await billing.handleWebhook(event(retryId, 'customer.subscription.updated', {
      id: 'sub_acme', customer: `cus_${organization.id}`, status: 'active',
      items: { data: [{ id: 'si_individual', price: { id: 'price_individual' }, quantity: 1 }] },
    }, 101)))).toEqual({ duplicate: false });
    expect((await store.getOrganization(organization.id))?.plan).toBe('individual');

    (await billing.handleWebhook(event('evt_team', 'customer.subscription.updated', {
      id: 'sub_acme', customer: `cus_${organization.id}`, status: 'active',
      items: { data: [{ id: 'si_base', price: { id: 'price_team_base' }, quantity: 1 }] },
    }, 102)));
    (await store.setOrganizationMembership(organization.id, 'second', 'member'));
    await billing.syncSeats(organization.id);
    expect(provider.calls.at(-1)).toMatchObject({ method: 'updateSeats', input: {
      subscriptionId: 'sub_acme', seats: 2,
    } });
    // Provider submission is not itself verified seat state.
    expect((await billing.current(organization.id))).toMatchObject({ seats: 1, activeUsers: 2, seatDeficit: 1 });
  });

  it('derives every lifecycle entitlement and closes past-due grace without deleting members', async () => {
    const store = (await Store.create(':memory:', { hosted: true }));
    const organization = (await store.createOrganization({ name: 'Lifecycle', ownerUserId: 'owner' }));
    const provider = new FakeSubscriptionProvider();
    const billing = new SubscriptionBillingService(store, provider, true);
    await billing.checkout(organization.id, 'team',
      { success: 'https://krmax.test/success', cancel: 'https://krmax.test/cancel' }, 'checkout-lifecycle');
    const subscription = (status: string) => ({
      id: 'sub_lifecycle', customer: `cus_${organization.id}`, status,
      items: { data: [{ id: 'si_base', price: { id: 'price_team_base' }, quantity: 1 }] },
    });

    (await billing.handleWebhook(event('evt_trial', 'customer.subscription.updated', subscription('trialing'), 200)));
    expect((await store.getOrganization(organization.id))?.plan).toBe('team');
    await expect((async () => (await billing.assertOrganizationDeletionAllowed(organization.id)))()).rejects.toThrow('provider subscription is trialing');
    (await store.setOrganizationMembership(organization.id, 'second', 'member'));

    (await billing.handleWebhook(event('evt_past_due', 'invoice.payment_failed', {
      id: 'in_lifecycle', customer: `cus_${organization.id}`, subscription: 'sub_lifecycle',
    }, 210)));
    const graceEndsAt = (await billing.current(organization.id)).graceEndsAt!;
    expect(graceEndsAt).toBeGreaterThan(Date.now());
    expect((await store.getOrganization(organization.id))?.plan).toBe('team');

    // The scheduled sweep derives Free from the already-verified failure once
    // grace elapses; no later provider event and no destructive member removal
    // are required.
    (await billing.reconcileEntitlements(graceEndsAt + 1));
    expect((await store.getOrganization(organization.id))?.plan).toBe('free');
    expect((await store.listOrganizationMemberships(organization.id))).toHaveLength(2);
    expect((await store.organizationEntitlements(organization.id))).toMatchObject({
      currentMemberCount: 2, overMemberLimit: true,
      memberAdmissionAllowed: false, agentRunAdmissionAllowed: false,
    });
    await expect((async () => (await billing.assertOrganizationDeletionAllowed(organization.id)))()).rejects.toThrow('provider subscription is past_due');
    await expect((async () => (await store.setOrganizationMembership(organization.id, 'third', 'member')))()).rejects.toThrow('Remove 1 member or restore Team');

    (await billing.handleWebhook(event('evt_recovered', 'invoice.paid', {
      id: 'in_lifecycle', customer: `cus_${organization.id}`, subscription: 'sub_lifecycle',
    }, 220)));
    expect((await store.getOrganization(organization.id))?.plan).toBe('team');
    expect((await store.organizationEntitlements(organization.id))).toMatchObject({
      overMemberLimit: false, memberAdmissionAllowed: true, agentRunAdmissionAllowed: true,
    });
    for (const [index, status] of ['unpaid', 'incomplete', 'incomplete_expired', 'paused', 'canceled'].entries()) {
      const created = 230 + index * 2;
      (await billing.handleWebhook(event(`evt_${status}`, 'customer.subscription.updated', subscription(status), created)));
      expect((await store.getOrganization(organization.id))?.plan, status).toBe('free');
      if (status === 'incomplete_expired' || status === 'canceled')
        await (async () => (await billing.assertOrganizationDeletionAllowed(organization.id)))();
      else await expect((async () => (await billing.assertOrganizationDeletionAllowed(organization.id)))()).rejects.toThrow(`provider subscription is ${status}`);
      if (index < 4) {
        (await billing.handleWebhook(event(`evt_active_${index}`, 'customer.subscription.updated', subscription('active'), created + 1)));
        expect((await store.getOrganization(organization.id))?.plan).toBe('team');
      }
    }
    (await billing.handleWebhook(event('evt_deleted', 'customer.subscription.deleted', subscription('canceled'), 300)));
    expect((await store.getOrganization(organization.id))?.plan).toBe('free');
    await (async () => (await billing.assertOrganizationDeletionAllowed(organization.id)))();
    (await billing.handleWebhook(event('evt_late_invoice', 'invoice.paid', {
      id: 'in_late', customer: `cus_${organization.id}`, subscription: 'sub_lifecycle',
    }, 310)));
    expect((await store.getOrganization(organization.id))?.plan).toBe('free');
    await expect(billing.checkout(organization.id, 'individual',
      { success: 'https://krmax.test/success', cancel: 'https://krmax.test/cancel' }, 'checkout-too-many-users'))
      .rejects.toThrow('remove additional active users before choosing Individual');
    const nextCheckout = await billing.checkout(organization.id, 'team',
      { success: 'https://krmax.test/success', cancel: 'https://krmax.test/cancel' }, 'checkout-team-again');
    expect(nextCheckout).toMatchObject({
      organizationId: organization.id, plan: 'team',
      checkoutRequestReference: 'checkout-team-again', checkoutSessionReference: 'cs_test',
      commercialTerms: { activeUsers: 2, monthlyTotalPriceCents: 2_400 },
    });
    expect(PAST_DUE_GRACE_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('preserves private/self-hosted behavior without calling a provider', async () => {
    const store = (await Store.create(':memory:'));
    const organization = (await store.createOrganization({ name: 'Private', ownerUserId: 'owner' }));
    const provider = new FakeSubscriptionProvider();
    const billing = new SubscriptionBillingService(store, provider, false);
    expect((await billing.current(organization.id))).toMatchObject({ managed: false, plan: 'self_hosted', status: 'unmetered' });
    await billing.syncSeats(organization.id);
    expect(provider.calls).toEqual([]);
    await expect(billing.checkout(organization.id, 'individual',
      { success: 'https://x', cancel: 'https://x' }, 'checkout-private')).rejects.toThrow('self-hosted');
  });
});

describe('Stripe subscription provider', () => {
  const env = {
    KARMAX_SUBSCRIPTION_STRIPE_SECRET_KEY: 'sk_test_billing',
    KARMAX_SUBSCRIPTION_STRIPE_WEBHOOK_SECRET: 'whsec_billing',
    KARMAX_SUBSCRIPTION_STRIPE_INDIVIDUAL_PRICE_ID: 'price_ind',
    KARMAX_SUBSCRIPTION_STRIPE_TEAM_BASE_PRICE_ID: 'price_team',
    KARMAX_SUBSCRIPTION_STRIPE_TEAM_SEAT_PRICE_ID: 'price_seat',
  };

  it('uses configured price IDs and a distinct Billing credential namespace', async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as any).authorization).toBe('Bearer sk_test_billing');
      expect((init?.headers as any)['stripe-version']).toBe(STRIPE_BILLING_API_VERSION);
      return new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const provider = new StripeSubscriptionProvider(env, fetcher as any);
    await provider.createCheckout({ organizationId: 'org_1', customerId: 'cus_1', plan: 'team', seats: 3,
      successUrl: 'https://krmax.test/success', cancelUrl: 'https://krmax.test/cancel', idempotencyKey: 'request-123' });
    const body = fetcher.mock.calls[0]![1]!.body as URLSearchParams;
    expect(body.get('line_items[0][price]')).toBe('price_team');
    expect(body.get('line_items[1][price]')).toBe('price_seat');
    expect(body.get('line_items[1][quantity]')).toBe('2');
    expect((fetcher.mock.calls[0]![1]!.headers as any)['idempotency-key']).toBe('request-123');
  });

  it('verifies the exact raw payload, signature, and timestamp', async () => {
    const provider = new StripeSubscriptionProvider(env, vi.fn() as any);
    const raw = event('evt_signed', 'invoice.paid', { id: 'in_1' }, Math.floor(Date.now() / 1000));
    const timestamp = Math.floor(Date.now() / 1000);
    const digest = crypto.createHmac('sha256', env.KARMAX_SUBSCRIPTION_STRIPE_WEBHOOK_SECRET)
      .update(`${timestamp}.${raw.toString('utf8')}`).digest('hex');
    expect((await provider.verifyWebhook(raw, `t=${timestamp},v1=${digest}`)).id).toBe('evt_signed');
    await expect(provider.verifyWebhook(raw, `t=${timestamp},v1=bad`)).rejects.toThrow('invalid subscription webhook signature');
  });

  it('reconciles Dahlia item periods and invoice parent references', async () => {
    const store = (await Store.create(':memory:', { hosted: true }));
    const organization = (await store.createOrganization({ name: 'Dahlia', ownerUserId: 'owner' }));
    const billing = new SubscriptionBillingService(store, new FakeSubscriptionProvider(), true);
    await billing.checkout(organization.id, 'team',
      { success: 'https://krmax.test/success', cancel: 'https://krmax.test/cancel' }, 'checkout-dahlia');
    (await billing.handleWebhook(event('evt_dahlia_subscription', 'customer.subscription.updated', {
      id: 'sub_dahlia', customer: `cus_${organization.id}`, status: 'active', cancel_at_period_end: false,
      items: { data: [
        { id: 'si_base', price: { id: 'price_team_base' }, quantity: 1, current_period_end: 2_000 },
        { id: 'si_seat', price: { id: 'price_team_seat' }, quantity: 2, current_period_end: 2_000 },
      ] },
    }, 100)));
    expect((await billing.current(organization.id))).toMatchObject({
      plan: 'team', status: 'active', seats: 3, currentPeriodEnd: 2_000_000,
    });

    // Dahlia invoices no longer expose invoice.subscription. Omit customer as
    // well so this proves reconciliation follows the new parent reference.
    (await billing.handleWebhook(event('evt_dahlia_failed', 'invoice.payment_failed', {
      id: 'in_dahlia', parent: { type: 'subscription_details',
        subscription_details: { subscription: 'sub_dahlia' } },
    }, 110)));
    expect((await billing.current(organization.id))).toMatchObject({ status: 'past_due', access: 'grace' });
    (await store.close());
  });
});

describe('subscription administration HTTP authorization', () => {
  let store: Store;
  let tokens: TokenAuthority;
  let billing: SubscriptionBillingService;
  let provider: FakeSubscriptionProvider;
  let base: string;
  let close: () => Promise<void>;
  let browserToken: string;
  let memberOrganizationId: string;

  beforeAll(async () => {
    store = (await Store.create(':memory:', { hosted: true }));
    tokens = new TokenAuthority();
    provider = new FakeSubscriptionProvider();
    billing = new SubscriptionBillingService(store, provider, true);
    const launchEnv = {
      KARMAX_PAID_LAUNCH: '1', KARMAX_FOUNDER_REVIEWED_POLICY_VERSION: POLICY_VERSION,
      KARMAX_LEGAL_ENTITY_NAME: 'Configured Operator', KARMAX_LEGAL_ENTITY_COUNTRY: 'Configured Country',
      KARMAX_GOVERNING_LAW: 'Configured Law', KARMAX_LEGAL_NOTICE_ADDRESS: 'Configured Notice Address',
      KARMAX_LEGAL_EMAIL: 'legal@example.test', KARMAX_PRIVACY_EMAIL: 'privacy@example.test',
      KARMAX_SECURITY_EMAIL: 'security@example.test', KARMAX_INCIDENT_EMAIL: 'incident@example.test',
      KARMAX_DPA_EMAIL: 'dpa@example.test', KARMAX_BILLING_EMAIL: 'billing@example.test',
    };
    for (const [name, value] of Object.entries(launchEnv)) vi.stubEnv(name, value);
    const memberOrganization = (await store.createOrganization({ name: 'Member only' }));
    memberOrganizationId = memberOrganization.id;
    (await store.setOrganizationMembership(memberOrganization.id, 'me', 'member'));
    const client = { workflow: { getHandle: () => ({}) } } as any;
    const worlds = new WorldRegistry();
    const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens,
      contentDir: fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-billing-content-')), worlds });
    const gateway = (await Gateway.create({ api, store, tokens, client, taskQueue: 'test', worlds,
      bus: new KarmaxBus(), contributions: new ContributionRegistry(), overlays: new Overlays(),
      authorization: (await AuthorizationService.create(store)), subscriptions: billing,
      staticDir: fileURLToPath(new URL('../web', import.meta.url)),
      agentInfo: { provider: 'mock', reason: 'billing authorization test' },
    } as any));
    const started = await gateway.listen(await findFreePortFrom(49_700));
    base = started.url;
    close = started.close;
    browserToken = (await (await fetch(`${base}/api/session`)).json() as any).token;
  });

  afterAll(async () => {
    await close?.();
    (await store?.close());
    vi.unstubAllEnvs();
  });

  const post = (action: 'gift' | 'checkout' | 'portal' | 'change' | 'cancel' | 'sync-seats',
    organizationId: string, token: string, body: Record<string, unknown> = {}) => fetch(
    `${base}/api/organizations/${organizationId}/subscription/${action}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
        'idempotency-key': `billing-${crypto.randomUUID()}` }, body: JSON.stringify({ plan: 'individual',
        acceptedPolicies: true, policyVersions: policyVersions('checkout'), ...body }),
    });

  it.each(['checkout', 'portal', 'change', 'cancel', 'sync-seats'] as const)(
    'rejects an agent without a verified owner subject from %s', async (action) => {
      const agent = (await tokens.mint({ taskId: `task_billing_attack_${action}`, profileId: 'developer', principal: 'agent:test',
        organizationId: memberOrganizationId, ceiling: ['payment:write'], grantorCaps: ['payment:write'] })).token;
      const response = await post(action, memberOrganizationId, agent);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: 'a verified human subject is required' });
    });

  it('lists personal subscriptions without trusting requested user IDs or widening scoped access', async () => {
    const org = await store.createOrganization({ name: 'Profile billing workspace', ownerUserId: 'me' });
    vi.spyOn(provider, 'createCheckout').mockResolvedValueOnce({ id: 'cs_profile_http', url: 'https://checkout.test/profile' });
    expect((await post('checkout', org.id, browserToken)).status).toBe(200);
    const list = (token = browserToken) => fetch(`${base}/api/user/paid-subscriptions?userId=someone-else`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect((await (await list()).json() as any).subscriptions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ organizationId: org.id })]));
    await billing.handleWebhook(event('profile-http-active', 'customer.subscription.updated', {
      id: 'sub_profile_http', customer: `cus_${org.id}`, status: 'active',
      items: { data: [{ id: 'si', price: { id: 'price_individual' }, quantity: 1 }] },
    }));
    await billing.handleWebhook(event('profile-http-complete', 'checkout.session.completed', {
      id: 'cs_profile_http', subscription: 'sub_profile_http', customer: `cus_${org.id}`,
    }, 101));
    const result = await (await list()).json() as any;
    expect(result.subscriptions).toContainEqual(expect.objectContaining({ organizationId: org.id,
      organizationName: org.name, plan: 'individual', canManage: true, settingsUrl: `/${org.slug}/settings#settings-plan` }));
    expect(JSON.stringify(result)).not.toMatch(/sub_profile_http|cs_profile_http|commercialTerms|customerId/);
    const other = await tokens.mintPrincipal('user:someone-else', ['payment:*']);
    // A bare principal token is not proof of a human subject.
    expect((await list(other.token)).status).toBe(403);
    const scoped = await tokens.mintPrincipal('user:me', ['payment:*'], undefined, undefined, org.id);
    expect((await list(scoped.token)).status).toBe(403);
    const delegation = (await tokens.delegateHuman(scoped.token, { taskId: 'personal-billing-scoped', organizationId: org.id }))!;
    const delegated = await tokens.mint({ taskId: 'personal-billing-scoped', principal: 'task:personal-billing-scoped',
      profileId: 'administrator', organizationId: org.id, delegationId: delegation.id,
      ceiling: ['payment:read'], grantorCaps: ['payment:*'] });
    const scopedResponse = await list(delegated.token);
    expect(scopedResponse.status).toBe(403);
    expect(await scopedResponse.json()).toMatchObject({ error: 'unscoped personal access is required' });
    const agent = await tokens.mint({ taskId: 'task_personal_billing', profileId: 'developer', principal: 'agent:test',
      ceiling: ['payment:write'], grantorCaps: ['payment:write'] });
    expect((await list(agent.token)).status).toBe(403);
    await billing.gift(org.id, 'team', 'user:operator', 'profile-owner-transfer');
    await store.setOrganizationMembership(org.id, 'replacement-owner', 'owner');
    await store.removeOrganizationMembership(org.id, 'me');
    expect((await (await list()).json() as any).subscriptions).toContainEqual(expect.objectContaining({
      organizationId: org.id, canManage: false, settingsUrl: null }));
    await store.db.prepare('DELETE FROM policy_acceptances WHERE organizationId=?').run(org.id);
  });

  it.each(['checkout', 'portal', 'change', 'cancel', 'sync-seats'] as const)(
    'rejects an interactive non-owner from %s', async (action) => {
      const response = await post(action, memberOrganizationId, browserToken);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: 'organization owner access is required to administer its subscription' });
    });

  it('requires the current checkout policy versions before creating a provider session', async () => {
    const missing = await post('checkout', 'org_personal', browserToken, { acceptedPolicies: false });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: expect.stringMatching(/affirmative policy acceptance/i) });
    const stale = await post('checkout', 'org_personal', browserToken, {
      policyVersions: { ...policyVersions('checkout'), billing: 'stale' },
    });
    expect(stale.status).toBe(400);
    expect(await stale.json()).toMatchObject({ error: expect.stringMatching(/current billing policy version/i) });
    expect(provider.calls.filter((call) => call.method === 'createCheckout')).toHaveLength(0);
    expect((await store.policyAcceptances('me')).filter((acceptance) => acceptance.context === 'checkout')).toHaveLength(0);
  });

  it('allows a delegated owner agent with payment authority to manage billing', async () => {
    const human = (await tokens.mintPrincipal('user:me', ['payment:write', 'organization:read'], undefined, undefined, 'org_personal'));
    const delegation = (await tokens.delegateHuman(human.token, { taskId: 'billing-agent', organizationId: 'org_personal' }))!;
    const agent = (await tokens.mint({ taskId: 'billing-agent', profileId: 'administrator', principal: 'task:billing-agent',
      organizationId: 'org_personal', delegationId: delegation.id,
      ceiling: ['payment:write', 'organization:read'], grantorCaps: ['payment:write', 'organization:read'] }));
    const response = await post('checkout', 'org_personal', agent.token);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ url: 'https://checkout.test/session' });
    const status = await fetch(`${base}/api/organizations/org_personal/subscription/status`, {
      headers: { authorization: `Bearer ${agent.token}` },
    });
    expect(await status.json()).toMatchObject({ canManage: true });
  });

  it('allows the interactive owner of the organization', async () => {
    const response = await post('checkout', 'org_personal', browserToken);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      organizationId: 'org_personal', plan: 'individual',
      url: 'https://checkout.test/session', checkoutProvider: 'fake-billing',
      checkoutRequestReference: expect.stringMatching(/^billing-/), checkoutSessionReference: 'cs_test',
      commercialTerms: { planId: 'individual', monthlyBasePriceCents: 900,
        activeUsers: 1, monthlyTotalPriceCents: 900 },
    });
    expect((await store.policyAcceptances('me')).at(-1)).toMatchObject({
      userId: 'me', organizationId: 'org_personal', context: 'checkout',
      versions: policyVersions('checkout'), checkoutSessionReference: 'cs_test',
      checkoutRequestReference: expect.stringMatching(/^billing-/), commercialTerms: {
        planId: 'individual', monthlyBasePriceCents: 900,
        monthlyAdditionalActiveUserPriceCents: 0, currency: 'usd', billingInterval: 'month',
        autoRenews: true, renewalDisclosure: expect.stringMatching(/renews monthly/i),
        cancellationDisclosure: expect.stringMatching(/cancel online/i),
        refundDisclosure: expect.stringMatching(/payment provider.*buyer terms/i),
      },
    });
  });

  it('lets Gods gift across organizations through the API while denying ordinary payment authority', async () => {
    const recipient = await store.createOrganization({ name: 'Outside God membership', ownerUserId: 'someone-else' });
    const before = provider.calls.length;
    const result = await post('gift', recipient.id, browserToken, { plan: 'team' });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ plan: 'team', gift: { plan: 'team', grantedBy: 'user:me' } });
    expect(provider.calls.length).toBe(before);
    const state = await fetch(`${base}/api/organizations/${recipient.id}/subscription/status`, {
      headers: { authorization: `Bearer ${browserToken}` },
    });
    expect(await state.json()).toMatchObject({ canGift: true, canManage: false });
    const owner = await tokens.mintPrincipal('user:someone-else', ['organization:*', 'payment:*'], undefined, undefined, recipient.id);
    expect((await post('gift', recipient.id, owner.token)).status).toBe(403);
    const ordinaryState = await fetch(`${base}/api/organizations/${recipient.id}/subscription/status`, {
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(await ordinaryState.json()).toMatchObject({ canGift: false });
    const human = await tokens.mintPrincipal('user:someone-else', ['organization:read', 'payment:write'], undefined, undefined, recipient.id);
    const delegation = (await tokens.delegateHuman(human.token, { taskId: 'owner-gift-agent', organizationId: recipient.id }))!;
    const ownerAgent = await tokens.mint({ taskId: 'owner-gift-agent', profileId: 'administrator', principal: 'task:owner-gift-agent',
      organizationId: recipient.id, delegationId: delegation.id,
      ceiling: ['organization:read', 'payment:write'], grantorCaps: ['organization:read', 'payment:write'] });
    expect((await post('gift', recipient.id, ownerAgent.token)).status).toBe(403);
    const ownerStatus = await fetch(`${base}/api/organizations/${recipient.id}/subscription/status`, {
      headers: { authorization: `Bearer ${ownerAgent.token}` },
    });
    expect(await ownerStatus.json()).toMatchObject({ canManage: true, canGift: false });
    expect(await store.db.prepare("SELECT principalId FROM audit_log WHERE action='subscription.gift' AND scopeKey=?")
      .all(`organization:${recipient.id}`)).toEqual([{ principalId: 'user:me' }]);
    const agent = await tokens.mint({ taskId: 'gift-agent', profileId: 'god', principal: 'task:gift-agent',
      ceiling: ['*'], grantorCaps: ['*'] });
    expect((await post('gift', recipient.id, agent.token, { plan: 'individual' })).status).toBe(200);
    const scoped = await tokens.mint({ taskId: 'scoped-gift-agent', profileId: 'god', principal: 'task:scoped-gift-agent',
      organizationId: 'org_personal', ceiling: ['*'], grantorCaps: ['*'] });
    expect((await post('gift', recipient.id, scoped.token)).status).toBe(403);
    expect((await post('gift', recipient.id, agent.token, { plan: null })).status).toBe(200);
    expect((await billing.current(recipient.id)).plan).toBe('free');
  });

  it('makes owner-only administration explicit in subscription status', async () => {
    const memberState = await (await fetch(
      `${base}/api/organizations/${memberOrganizationId}/subscription/status`,
      { headers: { authorization: `Bearer ${browserToken}` } })).json() as any;
    const ownerState = await (await fetch(`${base}/api/organizations/org_personal/subscription/status`,
      { headers: { authorization: `Bearer ${browserToken}` } })).json() as any;
    expect(memberState.canManage).toBe(false);
    expect(ownerState.canManage).toBe(true);
  });

  it('blocks organization deletion for nonterminal billing even when effective access is Free', async () => {
    const organization = (await store.createOrganization({ name: 'Delete billing safely', ownerUserId: 'me' }));
    await billing.checkout(organization.id, 'individual',
      { success: 'https://krmax.test/success', cancel: 'https://krmax.test/cancel' }, 'checkout-delete-safety');
    const subscription = (status: string) => ({ id: `sub_${organization.id}`,
      customer: `cus_${organization.id}`, status,
      items: { data: [{ id: 'si_individual', price: { id: 'price_individual' }, quantity: 1 }] } });
    (await billing.handleWebhook(event('evt_delete_active', 'customer.subscription.updated', subscription('active'), 400)));
    (await billing.handleWebhook(event('evt_delete_unpaid', 'customer.subscription.updated', subscription('unpaid'), 410)));
    expect((await store.getOrganization(organization.id))?.plan).toBe('free');

    const remove = () => fetch(`${base}/api/organizations/${organization.id}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${browserToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ confirmSlug: organization.slug }),
    });
    const blocked = await remove();
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: expect.stringContaining('provider subscription is unpaid') });
    expect((await store.getOrganization(organization.id))).toBeDefined();

    (await billing.handleWebhook(event('evt_delete_canceled', 'customer.subscription.updated', subscription('canceled'), 420)));
    const removed = await remove();
    expect(removed.status).toBe(200);
    expect((await store.getOrganization(organization.id))).toBeUndefined();
  });
});
