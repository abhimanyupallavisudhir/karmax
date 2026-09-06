import type { CredentialBroker } from '../autonomy/broker.js';
import { STRIPE_BILLING_API_VERSION, STRIPE_BILLING_WEBHOOK_EVENTS } from '../billing/stripe-contract.js';
import type { Store } from '../store/db.js';
import { POLICY_VERSION, assertPaidLaunchReady, launchConfig, policyDocument, publicLaunchInfo,
  type StoredLaunchConfig } from './legal.js';

export const PAID_LAUNCH_SETTINGS_KEY = 'launch:paid-settings';
export const SUBSCRIPTION_STRIPE_SECRET_HANDLE = 'platform:stripe-subscriptions:secret-key';
export const SUBSCRIPTION_STRIPE_WEBHOOK_HANDLE = 'platform:stripe-subscriptions:webhook-secret';

export interface StoredPaidLaunchSettings extends StoredLaunchConfig {
  stripe?: {
    individualPriceId?: string;
    teamBasePriceId?: string;
    teamSeatPriceId?: string;
    individualProductId?: string;
    teamProductId?: string;
  };
  completedTasks?: string[];
}

export interface SubscriptionRuntimeConfig {
  secretKey?: string;
  webhookSecret?: string;
  individualPriceId?: string;
  teamBasePriceId?: string;
  teamSeatPriceId?: string;
  individualProductId?: string;
  teamProductId?: string;
}

export const FOUNDER_TASKS = [
  { id: 'business-structure', group: 'Business', title: 'Choose and create the legal business',
    instructions: 'Choose a jurisdiction and entity type with an accountant or lawyer, incorporate or register it, record the legal name and registered address below, and keep formation and beneficial-owner records.',
    href: 'https://stripe.com/atlas' },
  { id: 'bank-accounting', group: 'Business', title: 'Open banking and bookkeeping',
    instructions: 'Open a business bank account, keep company and personal funds separate, choose bookkeeping software, and decide who closes the books and files annual accounts.' },
  { id: 'tax-registration', group: 'Business', title: 'Review tax and sales-tax obligations',
    instructions: 'Obtain required tax IDs and ask an accountant where SaaS sales create VAT, GST, or sales-tax registration, collection, invoice, and filing duties. Configure Stripe Tax only if that advice calls for it.',
    href: 'https://stripe.com/tax' },
  { id: 'name-ip', group: 'Business', title: 'Clear the product and company name',
    instructions: 'Check company registries, domains, and relevant trademarks for krmax/Karmax in launch markets; document ownership of the domain, code, brand assets, and contractor IP assignments.' },
  { id: 'stripe-account', group: 'Stripe Billing', title: 'Create and activate the Stripe account',
    instructions: 'Create the account in the legal entity’s name, complete owner/business verification, add the payout bank account and statement descriptor, enable live mode, and require MFA for administrators.',
    href: 'https://dashboard.stripe.com/register' },
  { id: 'stripe-products', group: 'Stripe Billing', title: 'Create products and recurring prices',
    instructions: 'In live mode create Individual at $9/month, Team base at $19/month, and Team additional active user at $5/month. Copy their price IDs—and optional product IDs—into the fields below.',
    href: 'https://dashboard.stripe.com/products' },
  { id: 'stripe-portal', group: 'Stripe Billing', title: 'Configure the customer portal',
    instructions: 'Allow payment-method updates, invoice viewing, and cancellation. Make the portal cancellation behavior match the Billing Policy and the in-app “cancel at period end” behavior.',
    href: 'https://dashboard.stripe.com/settings/billing/portal' },
  { id: 'stripe-webhook', group: 'Stripe Billing', title: 'Create the live webhook endpoint',
    instructions: 'Add the webhook URL shown below in Stripe Workbench using the API version and exact snapshot events listed in the Stripe Billing section, then copy its whsec_ signing secret below.',
    href: 'https://dashboard.stripe.com/workbench/webhooks' },
  { id: 'legal-review', group: 'Legal & privacy', title: 'Have launch policies reviewed',
    instructions: 'Replace assumptions and placeholders in Terms, Acceptable Use, Privacy, Billing, Security, Data, DPA, and Subprocessors with advice for the entity, jurisdiction, customers, data flows, and refund position. The included drafts are not legal advice.' },
  { id: 'privacy-map', group: 'Legal & privacy', title: 'Map data and publish subprocessors',
    instructions: 'Document personal data collected, purpose, location, retention, access, deletion, and cross-border transfers. Sign DPAs with infrastructure/AI vendors and keep the public subprocessors list accurate.' },
  { id: 'support-inboxes', group: 'Operations', title: 'Staff the public contact addresses',
    instructions: 'Create and monitor the legal, privacy, security, incident, DPA, and billing inboxes below. Assign a primary and backup owner, response targets, spam controls, and an escalation path.' },
  { id: 'incident-response', group: 'Operations', title: 'Create security and incident procedures',
    instructions: 'Write an incident runbook, breach assessment/notification flow, severity model, on-call contacts, evidence retention rules, and credential/key rotation procedure. Test it with a tabletop exercise.' },
  { id: 'data-operations', group: 'Operations', title: 'Test access, export, deletion, and retention',
    instructions: 'Run a real user export and account/organization deletion, verify backups and restore, define retention schedules, and document how requests are authenticated, tracked, completed, and evidenced.' },
  { id: 'billing-lifecycle', group: 'Launch verification', title: 'Exercise the full billing lifecycle in Stripe test mode',
    instructions: 'Test checkout, signed webhook delivery/replay, renewal, failed payment and grace, plan and seat changes, cancellation, portal access, refund handling, and organization deletion. Repeat one low-value end-to-end purchase in live mode.' },
  { id: 'launch-review', group: 'Launch verification', title: 'Review the public launch experience',
    instructions: 'Check pricing, disclosures, signup consent, all policy pages, receipts/invoices, support links, mobile layouts, accessibility, error states, monitoring, backups, and an internal support/offboarding handoff before announcing publicly.' },
] as const;

const taskIds = new Set<string>(FOUNDER_TASKS.map((task) => task.id));
const clean = (value: unknown) => typeof value === 'string' ? value.trim() || undefined : undefined;
const email = (value: unknown) => {
  const candidate = clean(value);
  if (candidate && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(candidate)) throw new Error(`${candidate} is not a valid contact email`);
  return candidate;
};

export class PaidLaunchSettingsService {
  constructor(private store: Pick<Store, 'kvGet' | 'kvSet'>, private broker: CredentialBroker,
    private env: NodeJS.ProcessEnv = process.env) {}

  stored(): StoredPaidLaunchSettings {
    try {
      const value = JSON.parse(this.store.kvGet(PAID_LAUNCH_SETTINGS_KEY) ?? '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  }

  launchConfig() { return launchConfig(this.env, this.stored()); }
  publicLaunchInfo(siteName?: string) { return publicLaunchInfo(this.env, this.stored(), siteName); }
  assertReady() { return assertPaidLaunchReady(this.env, this.stored()); }
  policyDocument(slug: string, siteName?: string) { return policyDocument(slug, this.env, this.stored(), siteName); }

  subscriptionConfig(): SubscriptionRuntimeConfig {
    const stripe = this.stored().stripe ?? {};
    const secret = (handle: string, fallback: string | undefined) => this.broker.hasHandle(handle)
      ? this.broker.resolve(handle, { caps: [`use-credential:${handle}`] }) : clean(fallback);
    return {
      ...stripe,
      secretKey: secret(SUBSCRIPTION_STRIPE_SECRET_HANDLE, this.env.KARMAX_SUBSCRIPTION_STRIPE_SECRET_KEY),
      webhookSecret: secret(SUBSCRIPTION_STRIPE_WEBHOOK_HANDLE, this.env.KARMAX_SUBSCRIPTION_STRIPE_WEBHOOK_SECRET),
      individualPriceId: stripe.individualPriceId ?? clean(this.env.KARMAX_SUBSCRIPTION_STRIPE_INDIVIDUAL_PRICE_ID),
      teamBasePriceId: stripe.teamBasePriceId ?? clean(this.env.KARMAX_SUBSCRIPTION_STRIPE_TEAM_BASE_PRICE_ID),
      teamSeatPriceId: stripe.teamSeatPriceId ?? clean(this.env.KARMAX_SUBSCRIPTION_STRIPE_TEAM_SEAT_PRICE_ID),
      individualProductId: stripe.individualProductId ?? clean(this.env.KARMAX_SUBSCRIPTION_STRIPE_INDIVIDUAL_PRODUCT_ID),
      teamProductId: stripe.teamProductId ?? clean(this.env.KARMAX_SUBSCRIPTION_STRIPE_TEAM_PRODUCT_ID),
    };
  }

  status(publicUrl: string) {
    const stored = this.stored();
    const launch = this.launchConfig();
    const stripe = this.subscriptionConfig();
    const billingMissing = [
      ['Stripe secret key', stripe.secretKey], ['Stripe webhook signing secret', stripe.webhookSecret],
      ['Individual price ID', stripe.individualPriceId], ['Team base price ID', stripe.teamBasePriceId],
      ['Team additional-user price ID', stripe.teamSeatPriceId],
    ].filter(([, value]) => !value).map(([label]) => label);
    const legalLabels: Record<string, string> = {
      KARMAX_FOUNDER_REVIEWED_POLICY_VERSION: `Founder approval of policy version ${POLICY_VERSION}`,
      KARMAX_LEGAL_ENTITY_NAME: 'Legal entity name', KARMAX_LEGAL_ENTITY_COUNTRY: 'Country of establishment',
      KARMAX_GOVERNING_LAW: 'Governing law and courts', KARMAX_LEGAL_NOTICE_ADDRESS: 'Legal notice address',
      KARMAX_LEGAL_EMAIL: 'Legal email', KARMAX_PRIVACY_EMAIL: 'Privacy email',
      KARMAX_SECURITY_EMAIL: 'Security email', KARMAX_INCIDENT_EMAIL: 'Incident email',
      KARMAX_DPA_EMAIL: 'DPA email', KARMAX_BILLING_EMAIL: 'Billing email',
    };
    return {
      ...launch,
      missing: launch.missing.map((name) => legalLabels[name] ?? name),
      policyVersion: POLICY_VERSION,
      founderReviewed: stored.founderReviewedPolicyVersion === POLICY_VERSION
        || (!stored.founderReviewedPolicyVersion && this.env.KARMAX_FOUNDER_REVIEWED_POLICY_VERSION === POLICY_VERSION),
      stripe: {
        individualPriceId: stripe.individualPriceId, teamBasePriceId: stripe.teamBasePriceId,
        teamSeatPriceId: stripe.teamSeatPriceId, individualProductId: stripe.individualProductId,
        teamProductId: stripe.teamProductId, secretKeyConfigured: Boolean(stripe.secretKey),
        webhookSecretConfigured: Boolean(stripe.webhookSecret), configured: billingMissing.length === 0,
        webhookUrl: `${publicUrl.replace(/\/$/, '')}/api/subscriptions/webhook`,
        apiVersion: STRIPE_BILLING_API_VERSION, webhookEvents: STRIPE_BILLING_WEBHOOK_EVENTS,
        missing: billingMissing,
      },
      completedTasks: (stored.completedTasks ?? []).filter((id) => taskIds.has(id)),
      tasks: FOUNDER_TASKS,
      canEnable: launch.ready && billingMissing.length === 0,
      source: this.store.kvGet(PAID_LAUNCH_SETTINGS_KEY) ? 'installation-settings' : 'environment-bootstrap',
    };
  }

  configure(input: Record<string, unknown>, publicUrl: string) {
    const current = this.stored();
    const stripeInput = input.stripe && typeof input.stripe === 'object' && !Array.isArray(input.stripe)
      ? input.stripe as Record<string, unknown> : {};
    const contactsInput = input.contacts && typeof input.contacts === 'object' && !Array.isArray(input.contacts)
      ? input.contacts as Record<string, unknown> : {};
    const id = (value: unknown, kind: 'price' | 'product') => {
      const candidate = clean(value);
      const prefix = kind === 'product' ? 'prod' : 'price';
      if (candidate && !new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(candidate))
        throw new Error(`${kind} IDs must start with ${prefix}_`);
      return candidate;
    };
    const secretKey = clean(stripeInput.secretKey);
    const webhookSecret = clean(stripeInput.webhookSecret);
    if (secretKey && !/^sk_(?:test|live)_\S+$/.test(secretKey))
      throw new Error('Stripe secret key must be an sk_test_… or sk_live_… key');
    if (webhookSecret && !/^whsec_\S+$/.test(webhookSecret))
      throw new Error('Stripe webhook signing secret must start with whsec_');
    if (secretKey) this.broker.registerHandle(SUBSCRIPTION_STRIPE_SECRET_HANDLE, secretKey);
    if (webhookSecret) this.broker.registerHandle(SUBSCRIPTION_STRIPE_WEBHOOK_HANDLE, webhookSecret);
    const next: StoredPaidLaunchSettings = {
      paidLaunch: input.paidLaunch === true,
      founderReviewedPolicyVersion: input.founderReviewed === true ? POLICY_VERSION : undefined,
      operatorName: clean(input.operatorName), operatorCountry: clean(input.operatorCountry),
      governingLaw: clean(input.governingLaw), legalNoticeAddress: clean(input.legalNoticeAddress),
      contacts: {
        legal: email(contactsInput.legal), privacy: email(contactsInput.privacy),
        security: email(contactsInput.security), incident: email(contactsInput.incident),
        dpa: email(contactsInput.dpa), billing: email(contactsInput.billing),
      },
      stripe: {
        individualPriceId: id(stripeInput.individualPriceId, 'price'),
        teamBasePriceId: id(stripeInput.teamBasePriceId, 'price'),
        teamSeatPriceId: id(stripeInput.teamSeatPriceId, 'price'),
        individualProductId: id(stripeInput.individualProductId, 'product'),
        teamProductId: id(stripeInput.teamProductId, 'product'),
      },
      completedTasks: Array.isArray(input.completedTasks)
        ? [...new Set(input.completedTasks.filter((value): value is string => typeof value === 'string' && taskIds.has(value)))]
        : current.completedTasks ?? [],
    };
    this.store.kvSet(PAID_LAUNCH_SETTINGS_KEY, JSON.stringify(next));
    const status = this.status(publicUrl);
    if (next.paidLaunch && !status.canEnable) {
      this.store.kvSet(PAID_LAUNCH_SETTINGS_KEY, JSON.stringify({ ...next, paidLaunch: false }));
      throw new Error(`Paid checkout cannot be enabled yet: ${[...status.missing, ...status.stripe.missing].join(', ')}`);
    }
    return status;
  }
}
