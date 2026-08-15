import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store/db.js';
import { FakeSubscriptionProvider, StripeSubscriptionProvider,
  PAST_DUE_GRACE_MS, SubscriptionBillingService } from '../src/billing/subscriptions.js';
import { Gateway } from '../src/gateway/server.js';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { AuthorizationService } from '../src/platform/authorization.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { WorldRegistry } from '../src/world/registry.js';
import { findFreePortFrom } from '../src/util/ports.js';

const event = (id: string, type: string, object: any, created = 100) =>
  Buffer.from(JSON.stringify({ id, type, created, data: { object } }));

describe('hosted subscription billing', () => {
  it('derives plan and seats only from verified provider events and reconciles failures idempotently', async () => {
    const store = new Store(':memory:', { hosted: true });
    const organization = store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
    const provider = new FakeSubscriptionProvider();
    const billing = new SubscriptionBillingService(store, provider, true);

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
    expect(billing.current(organization.id)).toMatchObject({ plan: 'free', status: 'none', seats: 1 });
    expect(store.getOrganization(organization.id)?.plan).toBe('free');
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
    expect(store.getOrganization(organization.id)?.plan).toBe('team');
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
    const store = new Store(':memory:', { hosted: true });
    const organization = store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
    const other = store.createOrganization({ name: 'Other', ownerUserId: 'other-owner' });
    const provider = new FakeSubscriptionProvider();
    const billing = new SubscriptionBillingService(store, provider, true);
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

    const retryId = 'evt_retry_after_reconciliation_error';
    expect(() => billing.handleWebhook(event(retryId, 'customer.subscription.updated', {
      id: 'sub_acme', customer: `cus_${organization.id}`, status: 'active',
      items: { data: [{ id: 'si_unknown', price: { id: 'price_unknown' }, quantity: 1 }] },
    }, 101))).toThrow('no configured Karmax plan price');
    expect(billing.handleWebhook(event(retryId, 'customer.subscription.updated', {
      id: 'sub_acme', customer: `cus_${organization.id}`, status: 'active',
      items: { data: [{ id: 'si_individual', price: { id: 'price_individual' }, quantity: 1 }] },
    }, 101))).toEqual({ duplicate: false });
    expect(store.getOrganization(organization.id)?.plan).toBe('individual');

    billing.handleWebhook(event('evt_team', 'customer.subscription.updated', {
      id: 'sub_acme', customer: `cus_${organization.id}`, status: 'active',
      items: { data: [{ id: 'si_base', price: { id: 'price_team_base' }, quantity: 1 }] },
    }, 102));
    store.setOrganizationMembership(organization.id, 'second', 'member');
    await billing.syncSeats(organization.id);
    expect(provider.calls.at(-1)).toMatchObject({ method: 'updateSeats', input: {
      subscriptionId: 'sub_acme', seats: 2,
    } });
    // Provider submission is not itself verified seat state.
    expect(billing.current(organization.id)).toMatchObject({ seats: 1, activeUsers: 2, seatDeficit: 1 });
  });

  it('derives every lifecycle entitlement and closes past-due grace without deleting members', async () => {
    const store = new Store(':memory:', { hosted: true });
    const organization = store.createOrganization({ name: 'Lifecycle', ownerUserId: 'owner' });
    const provider = new FakeSubscriptionProvider();
    const billing = new SubscriptionBillingService(store, provider, true);
    await billing.checkout(organization.id, 'team',
      { success: 'https://krmax.test/success', cancel: 'https://krmax.test/cancel' }, 'checkout-lifecycle');
    const subscription = (status: string) => ({
      id: 'sub_lifecycle', customer: `cus_${organization.id}`, status,
      items: { data: [{ id: 'si_base', price: { id: 'price_team_base' }, quantity: 1 }] },
    });

    billing.handleWebhook(event('evt_trial', 'customer.subscription.updated', subscription('trialing'), 200));
    expect(store.getOrganization(organization.id)?.plan).toBe('team');
    store.setOrganizationMembership(organization.id, 'second', 'member');

    billing.handleWebhook(event('evt_past_due', 'invoice.payment_failed', {
      id: 'in_lifecycle', customer: `cus_${organization.id}`, subscription: 'sub_lifecycle',
    }, 210));
    const graceEndsAt = billing.current(organization.id).graceEndsAt!;
    expect(graceEndsAt).toBeGreaterThan(Date.now());
    expect(store.getOrganization(organization.id)?.plan).toBe('team');

    // The scheduled sweep derives Free from the already-verified failure once
    // grace elapses; no later provider event and no destructive member removal
    // are required.
    billing.reconcileEntitlements(graceEndsAt + 1);
    expect(store.getOrganization(organization.id)?.plan).toBe('free');
    expect(store.listOrganizationMemberships(organization.id)).toHaveLength(2);
    expect(store.organizationEntitlements(organization.id)).toMatchObject({
      currentMemberCount: 2, overMemberLimit: true,
      memberAdmissionAllowed: false, agentRunAdmissionAllowed: false,
    });
    expect(() => store.setOrganizationMembership(organization.id, 'third', 'member'))
      .toThrow('Remove 1 member or restore Team');

    billing.handleWebhook(event('evt_recovered', 'invoice.paid', {
      id: 'in_lifecycle', customer: `cus_${organization.id}`, subscription: 'sub_lifecycle',
    }, 220));
    expect(store.getOrganization(organization.id)?.plan).toBe('team');
    expect(store.organizationEntitlements(organization.id)).toMatchObject({
      overMemberLimit: false, memberAdmissionAllowed: true, agentRunAdmissionAllowed: true,
    });
    for (const [index, status] of ['unpaid', 'incomplete', 'incomplete_expired', 'paused', 'canceled'].entries()) {
      const created = 230 + index * 2;
      billing.handleWebhook(event(`evt_${status}`, 'customer.subscription.updated', subscription(status), created));
      expect(store.getOrganization(organization.id)?.plan, status).toBe('free');
      if (index < 4) {
        billing.handleWebhook(event(`evt_active_${index}`, 'customer.subscription.updated', subscription('active'), created + 1));
        expect(store.getOrganization(organization.id)?.plan).toBe('team');
      }
    }
    billing.handleWebhook(event('evt_deleted', 'customer.subscription.deleted', subscription('canceled'), 300));
    expect(store.getOrganization(organization.id)?.plan).toBe('free');
    billing.handleWebhook(event('evt_late_invoice', 'invoice.paid', {
      id: 'in_late', customer: `cus_${organization.id}`, subscription: 'sub_lifecycle',
    }, 310));
    expect(store.getOrganization(organization.id)?.plan).toBe('free');
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
    const store = new Store(':memory:');
    const organization = store.createOrganization({ name: 'Private', ownerUserId: 'owner' });
    const provider = new FakeSubscriptionProvider();
    const billing = new SubscriptionBillingService(store, provider, false);
    expect(billing.current(organization.id)).toMatchObject({ managed: false, plan: 'self_hosted', status: 'unmetered' });
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

describe('subscription administration HTTP authorization', () => {
  let store: Store;
  let tokens: TokenAuthority;
  let billing: SubscriptionBillingService;
  let base: string;
  let close: () => Promise<void>;
  let browserToken: string;
  let memberOrganizationId: string;

  beforeAll(async () => {
    store = new Store(':memory:');
    tokens = new TokenAuthority();
    billing = new SubscriptionBillingService(store, new FakeSubscriptionProvider(), true);
    const memberOrganization = store.createOrganization({ name: 'Member only', ownerUserId: 'another-owner' });
    memberOrganizationId = memberOrganization.id;
    store.setOrganizationMembership(memberOrganization.id, 'me', 'member');
    const client = { workflow: { getHandle: () => ({}) } } as any;
    const worlds = new WorldRegistry();
    const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens,
      contentDir: fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-billing-content-')), worlds });
    const gateway = new Gateway({ api, store, tokens, client, taskQueue: 'test', worlds,
      bus: new KarmaxBus(), contributions: new ContributionRegistry(), overlays: new Overlays(),
      authorization: new AuthorizationService(store), subscriptions: billing,
      staticDir: fileURLToPath(new URL('../web', import.meta.url)),
      agentInfo: { provider: 'mock', reason: 'billing authorization test' },
    } as any);
    const started = await gateway.listen(await findFreePortFrom(49_700));
    base = started.url;
    close = started.close;
    browserToken = (await (await fetch(`${base}/api/session`)).json() as any).token;
  });

  afterAll(async () => {
    await close?.();
    store?.close();
  });

  const post = (action: 'checkout' | 'portal' | 'change' | 'cancel' | 'sync-seats',
    organizationId: string, token: string) => fetch(
    `${base}/api/organizations/${organizationId}/subscription/${action}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
        'idempotency-key': `billing-${crypto.randomUUID()}` }, body: JSON.stringify({ plan: 'individual' }),
    });

  it.each(['checkout', 'portal', 'change', 'cancel', 'sync-seats'] as const)(
    'rejects a task agent with payment:write from %s', async (action) => {
      const agent = tokens.mint({ taskId: `task_billing_attack_${action}`, profileId: 'developer', principal: 'agent:test',
        organizationId: memberOrganizationId, ceiling: ['payment:write'], grantorCaps: ['payment:write'] }).token;
      const response = await post(action, memberOrganizationId, agent);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: 'an interactive human session is required' });
    });

  it.each(['checkout', 'portal', 'change', 'cancel', 'sync-seats'] as const)(
    'rejects an interactive non-owner from %s', async (action) => {
      const response = await post(action, memberOrganizationId, browserToken);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: 'organization owner access is required to administer its subscription' });
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
});
