import { expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { FakeSubscriptionProvider, SubscriptionBillingService } from '../src/billing/subscriptions.js';

it.each([false, true])('lists only attributed, verified subscriptions (checkout association mode: %s)', async paddle => {
  const store = await Store.create(':memory:');
  const provider = new FakeSubscriptionProvider();
  if (paddle) Object.defineProperty(provider, 'customerMode', { value: 'checkout' });
  let sequence = 0;
  provider.createCheckout = async () => ({ id: `checkout-${++sequence}`, url: 'https://checkout.test/' });
  const billing = new SubscriptionBillingService(store, provider, true);
  const org = await store.createOrganization({ name: 'Paid workspace', ownerUserId: 'alice' });
  const urls = { success: 'https://test/s', cancel: 'https://test/c' };
  const activate = async (checkoutId: string, subscriptionId: string, created: number) => {
    await billing.handleWebhook(Buffer.from(JSON.stringify({ id: `active-${subscriptionId}`, created,
      type: 'customer.subscription.updated', ...(paddle ? { checkoutId } : {}),
      data: { object: { id: subscriptionId, customer: `cus_${org.id}`, status: 'active',
        items: { data: [{ id: 'si', price: { id: 'price_individual' }, quantity: 1 }] } } } })));
    if (!paddle) await billing.handleWebhook(Buffer.from(JSON.stringify({ id: `completed-${subscriptionId}`,
      created: created + 1, type: 'checkout.session.completed',
      data: { object: { id: checkoutId, subscription: subscriptionId, customer: `cus_${org.id}` } } })));
  };
  try {
    const checkout = await billing.checkout(org.id, 'individual', urls, 'profile-checkout-1');
    await store.setOrganizationMembership(org.id, 'bob', 'owner');
    await store.recordPolicyAcceptance({ userId: 'alice', organizationId: org.id, context: 'checkout',
      versions: {}, acceptedAt: 1, checkoutSessionReference: checkout.checkoutSessionReference });
    // A later owner reopening the same transaction is not a second purchaser.
    await store.recordPolicyAcceptance({ userId: 'bob', organizationId: org.id, context: 'checkout',
      versions: {}, acceptedAt: 2, checkoutSessionReference: checkout.checkoutSessionReference });
    expect(await billing.paidSubscriptionsForUser('alice')).toEqual([]);
    expect(await billing.hasPaidSubscription(org.id)).toBe(false);
    await activate(checkout.checkoutSessionReference, 'sub_first', 100);
    expect(await billing.paidSubscriptionsForUser('alice')).toEqual([expect.objectContaining({
      organizationId: org.id, plan: 'individual', status: 'active', planName: 'Individual' })]);
    expect(await billing.paidSubscriptionsForUser('bob')).toEqual([]);
    expect(await billing.paidSubscriptionsForUser('stranger')).toEqual([]);
    expect(await billing.hasPaidSubscription(org.id)).toBe(true);
    const gifted = await store.createOrganization({ name: 'Gift only', ownerUserId: 'alice' });
    await billing.gift(gifted.id, 'team', 'user:operator', 'profile-gift-1');
    expect(await billing.hasPaidSubscription(gifted.id)).toBe(false);
    expect(await billing.paidSubscriptionsForUser('alice')).toHaveLength(1);
    // Losing membership must not make a financial commitment disappear.
    await store.removeOrganizationMembership(org.id, 'alice');
    expect(await billing.paidSubscriptionsForUser('alice')).toHaveLength(1);
    await billing.handleWebhook(Buffer.from(JSON.stringify({ id: 'cancel-first', created: 110,
      type: 'customer.subscription.deleted', data: { object: { id: 'sub_first', customer: `cus_${org.id}` } } })));
    expect((await billing.paidSubscriptionsForUser('alice'))[0]?.status).toBe('canceled');
    const replacement = await billing.checkout(org.id, 'individual', urls, 'profile-checkout-2');
    await store.recordPolicyAcceptance({ userId: 'bob', organizationId: org.id, context: 'checkout',
      versions: {}, acceptedAt: 3, checkoutSessionReference: replacement.checkoutSessionReference });
    await activate(replacement.checkoutSessionReference, 'sub_replacement', 120);
    expect(await billing.paidSubscriptionsForUser('alice')).toEqual([]);
    expect(await billing.paidSubscriptionsForUser('bob')).toHaveLength(1);
    expect(await new SubscriptionBillingService(store, provider, false).paidSubscriptionsForUser('bob')).toEqual([]);
  } finally { await store.close(); }
});
