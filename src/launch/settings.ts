import { rememberSubscriptionCatalog } from '../billing/catalog.js';
import type { CredentialBroker } from '../autonomy/broker.js';
import { STRIPE_BILLING_API_VERSION, STRIPE_BILLING_WEBHOOK_EVENTS } from '../billing/stripe-contract.js';
import type { Store } from '../store/db.js';
import { PADDLE_WEBHOOK_EVENTS, type PaddleRuntimeConfig } from '../billing/paddle.js';
import { provisionPaddle } from '../billing/paddle-setup.js';
import { POLICY_VERSION, assertPaidLaunchReady, launchConfig, policyDocument, publicLaunchInfo,
  type StoredLaunchConfig } from './legal.js';

export const PAID_LAUNCH_SETTINGS_KEY = 'launch:paid-settings';
export const SUBSCRIPTION_STRIPE_SECRET_HANDLE = 'platform:stripe-subscriptions:secret-key';
export const SUBSCRIPTION_STRIPE_WEBHOOK_HANDLE = 'platform:stripe-subscriptions:webhook-secret';

export interface StoredPaidLaunchSettings extends StoredLaunchConfig {
  billingProvider?: 'stripe' | 'paddle';
  paddle?: Omit<PaddleRuntimeConfig, 'apiKey' | 'webhookSecret'>;
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
  { id: 'business-structure', group: 'Business', title: 'Confirm the legal operator',
    instructions: 'Use your legal name as a sole trader, or your incorporated entity. Record the country and legal notice address. Incorporation is not required to use Paddle; check your local registration duties.',
    href: 'https://www.gov.uk/become-sole-trader' },
  { id: 'bank-accounting', group: 'Business', title: 'Open banking and bookkeeping',
    instructions: 'Use an eligible payout account, keep accurate business records, and arrange the tax returns required for your business structure.' },
  { id: 'tax-registration', group: 'Business', title: 'Review tax and sales-tax obligations',
    instructions: 'A merchant of record handles customer sales taxes for its covered transactions, not your own income tax or all business obligations. Check registration, bookkeeping, and tax duties for your circumstances.' },
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
  { id: 'billing-lifecycle', group: 'Launch verification', title: 'Exercise the full billing lifecycle in a sandbox',
    instructions: 'Test checkout, signed webhook delivery/replay, renewal, failed payment and grace, plan and seat changes, cancellation, portal access, refund handling, and organization deletion. Repeat one low-value end-to-end purchase in live mode.' },
  { id: 'launch-review', group: 'Launch verification', title: 'Review the public launch experience',
    instructions: 'Check pricing, disclosures, signup consent, all policy pages, receipts/invoices, support links, mobile layouts, accessibility, error states, monitoring, backups, and an internal support/offboarding handoff before announcing publicly.' },
] as const;

const PADDLE_TASKS = [
  { id: 'paddle-account', group: 'Paddle Billing', title: 'Verify the Paddle account', instructions: 'Complete identity and website review as an individual or company, configure payouts, and enable MFA.', href: 'https://login.paddle.com/signup' },
  { id: 'paddle-catalog', group: 'Paddle Billing', title: 'Provision prices and webhooks', instructions: 'Use automated setup after saving the API key. Confirm the $9, $19, and $5 monthly USD prices and pricing for products below $10.' },
  { id: 'paddle-checkout', group: 'Paddle Billing', title: 'Approve the checkout domain', instructions: 'Set the default payment link to the checkout URL below and complete Paddle domain review. Create a client-side token for the same environment.', href: 'https://vendors.paddle.com' },
];

const taskIds = new Set<string>([...FOUNDER_TASKS, ...PADDLE_TASKS].map((task) => task.id));
const clean = (value: unknown) => typeof value === 'string' ? value.trim() || undefined : undefined;
const email = (value: unknown) => {
  const candidate = clean(value);
  if (candidate && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(candidate)) throw new Error(`${candidate} is not a valid contact email`);
  return candidate;
};

export class PaidLaunchSettingsService {
  private provisioning = false;
  constructor(private store: Pick<Store, 'kvGet' | 'kvSet' | 'db'>, private broker: CredentialBroker,
    private env: NodeJS.ProcessEnv = process.env) {}

  async stored(): Promise<StoredPaidLaunchSettings> {
    try {
      const value = JSON.parse((await this.store.kvGet(PAID_LAUNCH_SETTINGS_KEY)) ?? '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  }

  async launchConfig() { return launchConfig(this.env, (await this.stored())); }
  async billingProvider(): Promise<'stripe' | 'paddle'> {
    return (await this.stored()).billingProvider ?? (this.env.KARMAX_SUBSCRIPTION_PROVIDER === 'paddle' ? 'paddle' : 'stripe');
  }
  async paddleConfig(): Promise<PaddleRuntimeConfig> {
    const c = (await this.stored()).paddle ?? {};
    const bootstrapEnvironment = this.env.KARMAX_SUBSCRIPTION_PADDLE_ENVIRONMENT === 'sandbox' ? 'sandbox' : 'live';
    const environment = c.environment ?? bootstrapEnvironment;
    const bootstrap = (name: string) => environment === bootstrapEnvironment ? this.env[name] : undefined;
    const secret = (field: string, fallback?: string) => {
      const handle = `platform:paddle-subscriptions:${environment}:${field}`;
      return this.broker.hasHandle(handle) ? this.broker.resolve(handle, { caps: [`use-credential:${handle}`] }) : clean(fallback);
    };
    return { ...c, environment,
      apiKey: secret('api-key', bootstrap('KARMAX_SUBSCRIPTION_PADDLE_API_KEY')),
      webhookSecret: secret('webhook-secret', bootstrap('KARMAX_SUBSCRIPTION_PADDLE_WEBHOOK_SECRET')),
      clientToken: c.clientToken ?? clean(bootstrap('KARMAX_SUBSCRIPTION_PADDLE_CLIENT_TOKEN')),
      individualPriceId: c.individualPriceId ?? clean(bootstrap('KARMAX_SUBSCRIPTION_PADDLE_INDIVIDUAL_PRICE_ID')),
      teamBasePriceId: c.teamBasePriceId ?? clean(bootstrap('KARMAX_SUBSCRIPTION_PADDLE_TEAM_BASE_PRICE_ID')),
      teamSeatPriceId: c.teamSeatPriceId ?? clean(bootstrap('KARMAX_SUBSCRIPTION_PADDLE_TEAM_SEAT_PRICE_ID')),
    };
  }
  async provisionPaddle(publicUrl: string, siteName: string, fetcher: typeof fetch = fetch) {
    if (this.provisioning) throw new Error('Paddle setup is already running');
    this.provisioning = true;
    try {
      const c = await this.paddleConfig();
      return await provisionPaddle(c, publicUrl, siteName, async (patch) => {
        const current = await this.stored();
        if ((await this.paddleConfig()).environment !== c.environment) throw new Error('Paddle environment changed during setup');
        const { webhookSecret, apiKey: _key, ...publicPatch } = patch;
        if (webhookSecret) await this.broker.registerHandle(`platform:paddle-subscriptions:${c.environment}:webhook-secret`, webhookSecret);
        await this.store.kvSet(PAID_LAUNCH_SETTINGS_KEY, JSON.stringify({ ...current,
          paddle: { ...current.paddle, environment: c.environment, ...publicPatch } }));
      }, fetcher);
    } finally { this.provisioning = false; }
  }
  async publicLaunchInfo(siteName?: string) { return publicLaunchInfo(this.env, (await this.stored()), siteName); }
  async assertReady() { return assertPaidLaunchReady(this.env, (await this.stored())); }
  async policyDocument(slug: string, siteName?: string) { return policyDocument(slug, this.env, (await this.stored()), siteName); }

  async subscriptionConfig(): Promise<SubscriptionRuntimeConfig> {
    const stripe = (await this.stored()).stripe ?? {};
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

  async status(publicUrl: string) {
    const stored = (await this.stored());
    const launch = (await this.launchConfig());
    const stripe = (await this.subscriptionConfig());
    const billingProvider = await this.billingProvider();
    const paddle = await this.paddleConfig();
    const stripeMissing = [
      ['Stripe secret key', stripe.secretKey], ['Stripe webhook signing secret', stripe.webhookSecret],
      ['Individual price ID', stripe.individualPriceId], ['Team base price ID', stripe.teamBasePriceId],
      ['Team additional-user price ID', stripe.teamSeatPriceId],
    ].filter(([, value]) => !value).map(([label]) => label);
    const paddleMissing = [ ['Paddle API key', paddle.apiKey], ['Paddle webhook signing secret', paddle.webhookSecret],
      ['Paddle client-side token', paddle.clientToken], ['Individual price ID', paddle.individualPriceId],
      ['Team base price ID', paddle.teamBasePriceId], ['Team additional-user price ID', paddle.teamSeatPriceId],
    ].filter(([, value]) => !value).map(([label]) => label);
    const billingMissing = billingProvider === 'paddle' ? paddleMissing : stripeMissing;
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
      billingProvider,
      billingMissing,
      paddle: { environment: paddle.environment, clientToken: paddle.clientToken,
        individualPriceId: paddle.individualPriceId, teamBasePriceId: paddle.teamBasePriceId, teamSeatPriceId: paddle.teamSeatPriceId,
        individualProductId: paddle.individualProductId, teamProductId: paddle.teamProductId,
        secretKeyConfigured: Boolean(paddle.apiKey), webhookSecretConfigured: Boolean(paddle.webhookSecret),
        configured: paddleMissing.length === 0, missing: paddleMissing,
        webhookUrl: `${publicUrl.replace(/\/$/, '')}/api/subscriptions/paddle/webhook`,
        checkoutUrl: `${publicUrl.replace(/\/$/, '')}/billing/checkout`, webhookEvents: PADDLE_WEBHOOK_EVENTS },
      missing: launch.missing.map((name) => legalLabels[name] ?? name),
      policyVersion: POLICY_VERSION,
      founderReviewed: stored.founderReviewedPolicyVersion === POLICY_VERSION
        || (!stored.founderReviewedPolicyVersion && this.env.KARMAX_FOUNDER_REVIEWED_POLICY_VERSION === POLICY_VERSION),
      stripe: {
        individualPriceId: stripe.individualPriceId, teamBasePriceId: stripe.teamBasePriceId,
        teamSeatPriceId: stripe.teamSeatPriceId, individualProductId: stripe.individualProductId,
        teamProductId: stripe.teamProductId, secretKeyConfigured: Boolean(stripe.secretKey),
        webhookSecretConfigured: Boolean(stripe.webhookSecret), configured: stripeMissing.length === 0,
        webhookUrl: `${publicUrl.replace(/\/$/, '')}/api/subscriptions/webhook`,
        apiVersion: STRIPE_BILLING_API_VERSION, webhookEvents: STRIPE_BILLING_WEBHOOK_EVENTS,
        missing: stripeMissing,
      },
      completedTasks: (stored.completedTasks ?? []).filter((id) => taskIds.has(id)),
      tasks: billingProvider === 'paddle' ? [...FOUNDER_TASKS.filter((task) => task.group !== 'Stripe Billing'), ...PADDLE_TASKS] : FOUNDER_TASKS,
      canEnable: launch.ready && billingMissing.length === 0 && (billingProvider !== 'paddle' || paddle.environment === 'live'),
      source: (await this.store.kvGet(PAID_LAUNCH_SETTINGS_KEY)) ? 'installation-settings' : 'environment-bootstrap',
    };
  }

  async configure(input: Record<string, unknown>, publicUrl: string) {
    if (this.provisioning) throw new Error('wait for Paddle setup to finish before editing settings');
    const current = (await this.stored());
    await rememberSubscriptionCatalog(this.store, 'stripe-billing', await this.subscriptionConfig());
    await rememberSubscriptionCatalog(this.store, 'paddle-billing', await this.paddleConfig());
    if (input.billingProvider !== undefined && input.billingProvider !== 'stripe' && input.billingProvider !== 'paddle')
      throw new Error('choose Stripe or Paddle');
    const paddleInput = input.paddle && typeof input.paddle === 'object' && !Array.isArray(input.paddle)
      ? input.paddle as Record<string, unknown> : undefined;
    let paddle = current.paddle;
    if (paddleInput) {
      const currentEnvironment = (await this.paddleConfig()).environment;
      const environment = paddleInput.environment ?? currentEnvironment ?? 'live';
      if (environment !== 'live' && environment !== 'sandbox') throw new Error('choose Paddle live or sandbox');
      const changingEnvironment = currentEnvironment !== environment;
      if (changingEnvironment && await this.store.db.prepare("SELECT organizationId FROM subscription_billing_accounts WHERE provider='paddle-billing' LIMIT 1").get())
        throw new Error('Paddle billing records exist; use an isolated installation for sandbox testing instead of switching environments');
      const previous = changingEnvironment ? {} : current.paddle ?? {};
      const apiKey = clean(paddleInput.apiKey), webhookSecret = clean(paddleInput.webhookSecret);
      if (apiKey && !apiKey.startsWith(environment === 'sandbox' ? 'pdl_sdbx_apikey_' : 'pdl_live_apikey_'))
        throw new Error('Paddle API key does not match the selected environment');
      if (webhookSecret && !/^pdl_ntfset_\S+$/.test(webhookSecret)) throw new Error('Paddle webhook secret must start with pdl_ntfset_');
      const clientToken = paddleInput.clientToken === undefined ? previous.clientToken : clean(paddleInput.clientToken);
      if (clientToken && !new RegExp(`^${environment === 'sandbox' ? 'test' : 'live'}_[A-Za-z0-9]+$`).test(clientToken))
        throw new Error('Paddle client token does not match the selected environment');
      const paddleId = (field: keyof typeof previous, prefix: string) => {
        const value = paddleInput[field] === undefined ? previous[field] : clean(paddleInput[field]);
        if (value && !new RegExp(`^${prefix}_[a-z0-9]{26}$`).test(value)) throw new Error(`invalid Paddle ${field}`);
        return value;
      };
      paddle = { environment, clientToken, individualPriceId: paddleId('individualPriceId', 'pri'),
        teamBasePriceId: paddleId('teamBasePriceId', 'pri'), teamSeatPriceId: paddleId('teamSeatPriceId', 'pri'),
        individualProductId: paddleId('individualProductId', 'pro'), teamProductId: paddleId('teamProductId', 'pro') };
      if (apiKey) await this.broker.registerHandle(`platform:paddle-subscriptions:${environment}:api-key`, apiKey);
      if (webhookSecret) await this.broker.registerHandle(`platform:paddle-subscriptions:${environment}:webhook-secret`, webhookSecret);
    }
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
    if (secretKey) (await this.broker.registerHandle(SUBSCRIPTION_STRIPE_SECRET_HANDLE, secretKey));
    if (webhookSecret) (await this.broker.registerHandle(SUBSCRIPTION_STRIPE_WEBHOOK_HANDLE, webhookSecret));
    const next: StoredPaidLaunchSettings = {
      billingProvider: (input.billingProvider as 'stripe' | 'paddle' | undefined) ?? current.billingProvider,
      paddle,
      paidLaunch: input.paidLaunch === true,
      founderReviewedPolicyVersion: input.founderReviewed === true ? POLICY_VERSION : undefined,
      operatorName: clean(input.operatorName), operatorCountry: clean(input.operatorCountry),
      governingLaw: clean(input.governingLaw), legalNoticeAddress: clean(input.legalNoticeAddress),
      contacts: {
        legal: email(contactsInput.legal), privacy: email(contactsInput.privacy),
        security: email(contactsInput.security), incident: email(contactsInput.incident),
        dpa: email(contactsInput.dpa), billing: email(contactsInput.billing),
      },
      stripe: input.stripe === undefined ? current.stripe : {
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
    (await this.store.kvSet(PAID_LAUNCH_SETTINGS_KEY, JSON.stringify(next)));
    const status = (await this.status(publicUrl));
    if (next.paidLaunch && !status.canEnable) {
      (await this.store.kvSet(PAID_LAUNCH_SETTINGS_KEY, JSON.stringify({ ...next, paidLaunch: false })));
      throw new Error(`Paid checkout cannot be enabled yet: ${[...status.missing, ...status.billingMissing,
        ...(status.billingProvider === 'paddle' && status.paddle.environment !== 'live' ? ['Paddle live environment'] : [])].join(', ')}`);
    }
    return status;
  }
}
