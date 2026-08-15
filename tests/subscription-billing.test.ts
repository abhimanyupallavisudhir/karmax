import { describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { Store } from '../src/store/db.js';
import { FakeSubscriptionProvider, StripeSubscriptionProvider,
  SubscriptionBillingService } from '../src/billing/subscriptions.js';

const event = (id: string, type: string, object: any, created = 100) =>
  Buffer.from(JSON.stringify({ id, type, created, data: { object } }));

describe('hosted subscription billing', () => {
  it('derives plan and seats only from verified provider events and reconciles failures idempotently', async () => {
    const store = new Store(':memory:');
    const organization = store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
    const provider = new FakeSubscriptionProvider();
    const billing = new SubscriptionBillingService(store, provider, true);

    const checkout = await billing.checkout(organization.id, 'team',
      { success: 'https://krmax.test/success', cancel: 'https://krmax.test/cancel' }, 'checkout-request-1');
    expect(checkout.url).toBe('https://checkout.test/session');
    // A checkout response is not an entitlement claim. Until the signed
    // subscription event arrives, the organization is still Free.
    expect(billing.current(organization.id)).toMatchObject({ plan: 'free', status: 'none', seats: 1 });
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
    billing.handleWebhook(event('evt_checkout', 'checkout.session.completed', {
      id: 'cs_test', customer: `cus_${organization.id}`, subscription: 'sub_acme',
    }, 110));
    expect(billing.handleWebhook(event('evt_1', 'customer.subscription.updated', subscription))).toEqual({ duplicate: false });
    expect(billing.current(organization.id)).toMatchObject({ plan: 'team', status: 'active', seats: 3,
      activeUsers: 1, seatDeficit: 0, access: 'active' });
    expect(billing.handleWebhook(event('evt_1', 'customer.subscription.updated', subscription))).toEqual({ duplicate: true });

    billing.handleWebhook(event('evt_fail', 'invoice.payment_failed', {
      id: 'in_1', customer: `cus_${organization.id}`, subscription: 'sub_acme',
    }, 110));
    expect(billing.current(organization.id)).toMatchObject({ plan: 'team', status: 'past_due', access: 'grace',
      lastError: 'The latest subscription payment failed.' });
    billing.handleWebhook(event('evt_paid', 'invoice.paid', {
      id: 'in_1', customer: `cus_${organization.id}`, subscription: 'sub_acme',
    }, 120));
    expect(billing.current(organization.id)).toMatchObject({ plan: 'team', status: 'active', access: 'active' });

    // An older delivery is recorded but cannot roll current state backward.
    billing.handleWebhook(event('evt_old', 'invoice.payment_failed', {
      id: 'in_old', customer: `cus_${organization.id}`, subscription: 'sub_acme',
    }, 105));
    expect(billing.current(organization.id).status).toBe('active');
  });

  it('keeps server customer mappings as the tenant boundary and synchronizes active Team users', async () => {
    const store = new Store(':memory:');
    const organization = store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
    const other = store.createOrganization({ name: 'Other', ownerUserId: 'other-owner' });
    const provider = new FakeSubscriptionProvider();
    const billing = new SubscriptionBillingService(store, provider, true);
    expect(() => billing.assertMayAddMember(organization.id)).toThrow('upgrade');
    await billing.checkout(organization.id, 'team',
      { success: 'https://krmax.test/success', cancel: 'https://krmax.test/cancel' }, 'checkout-request-2');

    // A signed event with attacker-controlled metadata is ignored unless its
    // customer/subscription was first mapped by the server.
    billing.handleWebhook(event('evt_foreign', 'customer.subscription.updated', {
      id: 'sub_foreign', customer: 'cus_foreign', status: 'active',
      metadata: { karmax_organization_id: other.id },
      items: { data: [{ id: 'si_ind', price: { id: 'price_individual' }, quantity: 1 }] },
    }));
    expect(billing.current(other.id).plan).toBe('free');

    billing.handleWebhook(event('evt_team', 'customer.subscription.updated', {
      id: 'sub_acme', customer: `cus_${organization.id}`, status: 'active',
      items: { data: [{ id: 'si_base', price: { id: 'price_team_base' }, quantity: 1 }] },
    }));
    expect(() => billing.assertMayAddMember(organization.id)).not.toThrow();
    store.setOrganizationMembership(organization.id, 'second', 'member');
    await billing.syncSeats(organization.id);
    expect(provider.calls.at(-1)).toMatchObject({ method: 'updateSeats', input: {
      subscriptionId: 'sub_acme', seats: 2,
    } });
    // Provider submission is not itself verified seat state.
    expect(billing.current(organization.id)).toMatchObject({ seats: 1, activeUsers: 2, seatDeficit: 1 });
  });

  it('preserves private/self-hosted behavior without calling a provider', async () => {
    const store = new Store(':memory:');
    const organization = store.createOrganization({ name: 'Private', ownerUserId: 'owner' });
    const provider = new FakeSubscriptionProvider();
    const billing = new SubscriptionBillingService(store, provider, false);
    expect(billing.current(organization.id)).toMatchObject({ managed: false, plan: 'self_hosted', status: 'unmetered' });
    billing.assertMayAddMember(organization.id);
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

  it('verifies the exact raw payload, signature, and timestamp', () => {
    const provider = new StripeSubscriptionProvider(env, vi.fn() as any);
    const raw = event('evt_signed', 'invoice.paid', { id: 'in_1' }, Math.floor(Date.now() / 1000));
    const timestamp = Math.floor(Date.now() / 1000);
    const digest = crypto.createHmac('sha256', env.KARMAX_SUBSCRIPTION_STRIPE_WEBHOOK_SECRET)
      .update(`${timestamp}.${raw.toString('utf8')}`).digest('hex');
    expect(provider.verifyWebhook(raw, `t=${timestamp},v1=${digest}`).id).toBe('evt_signed');
    expect(() => provider.verifyWebhook(raw, `t=${timestamp},v1=bad`)).toThrow('invalid subscription webhook signature');
  });
});
