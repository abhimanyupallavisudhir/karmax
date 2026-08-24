/** Stripe's snapshot-event contract used by hosted subscription billing.
 * Keep outbound API requests, the operator's webhook destination, and fixture
 * payloads on the same version so an account-default upgrade cannot silently
 * change the shapes we reconcile. */
export const STRIPE_BILLING_API_VERSION = '2026-06-24.dahlia';

export const STRIPE_BILLING_WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
] as const;
