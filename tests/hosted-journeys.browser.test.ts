import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import type { Browser, Page } from 'playwright';
import { hostedGateway, launchChromium, openConsole, signIn, type HostedGateway } from './helpers/browser.js';
import { WorldProviderConnectionService } from '../src/world/connections.js';
import { PaidLaunchSettingsService } from '../src/launch/settings.js';
import { POLICY_VERSION } from '../src/launch/legal.js';
import { PaddleSubscriptionProvider } from '../src/billing/paddle.js';
import { SubscriptionBillingService } from '../src/billing/subscriptions.js';

const PASSWORD = 'long-journey-password';
const PADDLE = { environment: 'live', apiKey: 'pdl_live_apikey_journey', webhookSecret: 'pdl_ntfset_journey',
  clientToken: 'live_journey', individualPriceId: `pri_${'i'.repeat(26)}`, teamBasePriceId: `pri_${'t'.repeat(26)}`,
  teamSeatPriceId: `pri_${'s'.repeat(26)}` } as const;
// An operator ready for paid launch: reviewed policies and published contacts.
const LAUNCH_ENV = {
  KARMAX_FOUNDER_REVIEWED_POLICY_VERSION: POLICY_VERSION, KARMAX_LEGAL_ENTITY_NAME: 'Journey Operator Ltd',
  KARMAX_LEGAL_ENTITY_COUNTRY: 'United Kingdom', KARMAX_GOVERNING_LAW: 'England and Wales',
  KARMAX_LEGAL_NOTICE_ADDRESS: '1 Journey Street, London',
  ...Object.fromEntries(['LEGAL', 'PRIVACY', 'SECURITY', 'INCIDENT', 'DPA', 'BILLING']
    .map((kind) => [`KARMAX_${kind}_EMAIL`, `${kind.toLowerCase()}@operator.example`])),
};

/** Paddle's transactions API, in memory: a checkout creates a ready
 *  transaction the way Paddle does; anything else is refused, so no request
 *  can ever leave the process. */
class PaddleStub {
  readonly transactions = new Map<string, any>();
  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET';
    if (url.origin !== 'https://api.paddle.com') throw new Error(`unexpected request to ${url.origin}`);
    if (method === 'POST' && url.pathname === '/transactions') {
      const body = JSON.parse(String(init!.body));
      const id = `txn_${crypto.randomBytes(20).toString('hex').slice(0, 26)}`;
      const transaction = { id, status: 'ready', origin: 'api', collection_mode: body.collection_mode, custom_data: body.custom_data,
        items: body.items.map((item: any) => ({ price: { id: item.price_id }, quantity: item.quantity })) };
      this.transactions.set(id, transaction);
      return Response.json({ data: transaction }, { status: 201 });
    }
    if (method === 'GET' && url.pathname === '/transactions')
      return Response.json({ data: [...this.transactions.values()], meta: { pagination: { has_more: false } } });
    const one = this.transactions.get(url.pathname.match(/^\/transactions\/([^/]+)$/)?.[1] ?? '');
    if (method === 'GET' && one) return Response.json({ data: one });
    return Response.json({ error: { code: 'not_found' } }, { status: 404 });
  }) as typeof fetch;

  /** The signed notification Paddle sends once the buyer has paid. */
  subscriptionCreated(transactionId: string) {
    const raw = JSON.stringify({ event_id: `evt_${transactionId}`, event_type: 'subscription.created', occurred_at: new Date().toISOString(),
      data: { id: 'sub_journey', customer_id: 'ctm_journey', transaction_id: transactionId, status: 'active',
        current_billing_period: { ends_at: new Date(Date.now() + 30 * 86_400_000).toISOString() }, scheduled_change: null,
        items: this.transactions.get(transactionId).items.map((item: any) => ({ ...item, price: { ...item.price, product_id: 'pro_journey' } })) } });
    const timestamp = Math.floor(Date.now() / 1000);
    return { raw, signature: `ts=${timestamp};h1=${crypto.createHmac('sha256', PADDLE.webhookSecret).update(`${timestamp}:${raw}`).digest('hex')}` };
  }
}

/** Fills and submits the console's sign-up card. */
async function signUp(page: Page, name: string, email: string) {
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password (10+ characters)').fill(PASSWORD);
  await page.locator('#signup-policy-acceptance').check();
  await page.locator('#signup-btn').click();
}

// Hosted (multi-tenant) journeys through the shipped console against a real
// gateway, identity service, authorization and billing. Nothing here starts a
// workflow, so one gateway without Temporal serves the whole file. Paid
// providers are stubbed: Paddle's API and checkout script, and the E2B
// connection check.
describe('hosted console journeys (real gateway, stubbed paid providers)', () => {
  let g: HostedGateway;
  let browser: Browser;
  const paddle = new PaddleStub();

  beforeAll(async () => {
    g = await hostedGateway(async ({ store, broker, url }) => {
      const paidLaunchSettings = new PaidLaunchSettingsService(store, broker, LAUNCH_ENV);
      await paidLaunchSettings.configure({ billingProvider: 'paddle', paidLaunch: true, paddle: PADDLE }, url);
      const providerConnections = new WorldProviderConnectionService(store, broker);
      // Verifying an E2B key lists sandboxes on E2B's API; the journey only
      // needs the saved connection.
      providerConnections.test = async (organizationId, provider) =>
        (await providerConnections.list(organizationId)).find((connection) => connection.provider === provider)!;
      return { paidLaunchSettings, providerConnections,
        subscriptions: new SubscriptionBillingService(store, new PaddleSubscriptionProvider(() => paidLaunchSettings.paddleConfig(), paddle.fetch), true) };
    });
    // The installation's first account, so sign-up is open to everyone else.
    await g.owner({ name: 'Operator', email: 'operator@example.test', password: PASSWORD, organization: 'Operator workspace' });
    browser = await launchChromium();
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await g?.close();
  });

  it('signs up from the landing page and finishes the setup guide (CI-38t)', async () => {
    const { page, errors, step, context } = await openConsole(browser, { ip: '192.0.2.11' });
    try {
      await step('open the landing page', () => page.goto(`${g.url}/`));
      await page.locator('#landing-hero-start').click();
      await signUp(page, 'Nadia New', 'nadia@example.test');
      const guide = page.locator('#hosted-onboarding .onboarding-card');
      await step('the setup guide opens', () => guide.waitFor());
      expect(await guide.locator('.onboarding-progress').getAttribute('aria-valuenow')).toBe('0');
      // A step's link tucks the guide into its progress pill while the person works.
      const completed = () => page.locator('#onboarding-expand small').innerText();
      const [user] = (await g.identity.listUsers()).filter((candidate) => candidate.email === 'nadia@example.test');
      const organization = (await g.store.defaultOrganization(user!.id))!;

      await guide.getByRole('link', { name: 'Add agent login' }).click();
      await page.locator('#acct-provider').fill('openai');
      await page.locator('#acct-name').fill('work');
      await page.locator('#acct-key').fill('sk-journey');
      await page.locator('#acct-add').click();
      await step('the agent key counts', () => expect.poll(completed, { timeout: 15_000 }).toBe('1 of 4 required steps'));

      await page.locator('#onboarding-expand').click();
      await guide.getByRole('link', { name: 'Set up E2B/Daytona' }).click();
      const e2b = page.locator('.provider-connection[data-provider="e2b"]');
      await e2b.locator('.provider-key').fill('e2b_journey');
      await e2b.locator('.provider-save').click();
      await step('the E2B key counts', () => expect.poll(completed, { timeout: 15_000 }).toBe('2 of 4 required steps'));

      // GitHub is connected on github.com: its installation callback records
      // the connection and sends the browser back to the console.
      await g.store.upsertGitConnection({ organizationId: organization.id, provider: 'github',
        installationId: 'journey-installation', accountLogin: 'nadia', accountType: 'User' });
      await page.goto(`${g.url}/${organization.slug}/settings?github=ready&organizationId=${organization.id}`);
      await step('GitHub counts', () => expect.poll(completed, { timeout: 15_000 }).toBe('3 of 4 required steps'));

      await page.locator('#onboarding-expand').click();
      await page.locator('#onboarding-new-project').click();
      await page.locator('#new-project-name').fill('First project');
      await page.locator('.new-project-dialog').getByRole('button', { name: 'Create project' }).click();
      await step('the new project opens', () => page.waitForURL(`**/${organization.slug}/first-project/settings`));
      await step('setup completes', () => expect.poll(() => page.evaluate((id) => fetch(`/api/user/onboarding?organizationId=${id}`)
        .then((response) => response.json()), organization.id)).toMatchObject({ complete: true, completedRequired: 4 }));
      await step('the guide steps aside', () => page.locator('#hosted-onboarding .onboarding-card').waitFor({ state: 'detached' }));
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 90_000);

  it('invites a teammate who signs up from the emailed link and joins the organization (CI-38u)', async () => {
    const { user: owner, organization } = await g.owner({ name: 'Olive Owner', email: 'olive@example.test', password: PASSWORD, organization: 'Olive Team' });
    await g.store.setOrganizationPlan(organization.id, 'team');
    const ownerConsole = await openConsole(browser, { ip: '192.0.2.21' });
    const invitee = await openConsole(browser, { ip: '192.0.2.22' });
    try {
      await signIn(ownerConsole.context, g.url, owner.email, PASSWORD);
      await ownerConsole.step('open People & authorization', () => ownerConsole.page.goto(`${g.url}/${organization.slug}/settings#settings-people`));
      await ownerConsole.page.locator('#invite-email').fill('ivan@example.test');
      await ownerConsole.page.locator('#invite-member').click();
      await ownerConsole.step('the invitation is sent', () => ownerConsole.page.locator('#invite-result').getByText('Invitation emailed to').waitFor());
      await ownerConsole.page.locator('#pending-invitations [data-invitation]').filter({ hasText: 'ivan@example.test' }).waitFor();
      const link = g.mailer.linkTo('ivan@example.test', '/invite?token=');
      expect(link).toBeTruthy();

      const { page, step } = invitee;
      await step('open the emailed link', () => page.goto(link!));
      await page.getByText('create an account').waitFor();
      await page.locator('#signup-open').click();
      await page.getByText('Accepting an invitation').waitFor();
      await signUp(page, 'Ivan Invitee', 'ivan@example.test');
      await step('the invitation is accepted', () => page.getByText('Invitation accepted.').waitFor());
      expect(new URL(page.url()).pathname).toBe(`/${organization.slug}/settings`);
      const [ivan] = (await g.identity.listUsers()).filter((candidate) => candidate.email === 'ivan@example.test');
      expect(await g.store.organizationMembership(organization.id, ivan!.id)).toBeTruthy();

      await ownerConsole.page.reload();
      await ownerConsole.step('the owner sees the new member', () => ownerConsole.page.locator(`#org-members [data-org-member="${ivan!.id}"]`).waitFor());
      expect(await ownerConsole.page.locator('#pending-invitations [data-invitation]').filter({ hasText: 'ivan@example.test' }).count()).toBe(0);
      expect([...ownerConsole.errors, ...invitee.errors]).toEqual([]);
    } finally {
      await ownerConsole.context.close();
      await invitee.context.close();
    }
  }, 90_000);

  it('buys the Individual plan through Paddle checkout and sees it active once Paddle confirms (CI-38v)', async () => {
    const { user: owner, organization } = await g.owner({ name: 'Paula Payer', email: 'paula@example.test', password: PASSWORD, organization: 'Paula Studio' });
    const { page, errors, step, context } = await openConsole(browser, { ip: '192.0.2.31' });
    // Paddle.js opens the transaction, and the buyer pays.
    await context.route('https://cdn.paddle.com/**', (route) => route.fulfill({ contentType: 'application/javascript', body: `
      window.Paddle = { Environment: { set() {} }, Checkout: { open() {} },
        Initialize(options) { setTimeout(() => options.eventCallback({ name: 'checkout.completed' }), 50); } };` }));
    try {
      await signIn(context, g.url, owner.email, PASSWORD);
      await step('open Plan & billing', () => page.goto(`${g.url}/${organization.slug}/settings#settings-plan`));
      await page.locator('#org-plan .section-h').filter({ hasText: 'Free' }).waitFor();
      await page.locator('#checkout-policy-acceptance').check();
      await page.locator('button.billing-checkout[data-plan="individual"]').click();
      await step('Paddle checkout returns to settings', () => page.waitForURL(/billing=success/));
      await page.getByText('Checkout completed').waitFor();
      const [transaction] = [...paddle.transactions.values()];
      expect(transaction.items).toEqual([{ price: { id: PADDLE.individualPriceId }, quantity: 1 }]);
      expect((await g.store.getOrganization(organization.id))?.plan ?? 'free').toBe('free');

      const notification = paddle.subscriptionCreated(transaction.id);
      const delivered = await fetch(`${g.url}/api/subscriptions/paddle/webhook`, { method: 'POST', body: notification.raw,
        headers: { 'paddle-signature': notification.signature } });
      expect(delivered.status).toBe(200);
      await page.reload();
      await step('the plan is active', () => page.locator('#org-plan .section-h').filter({ hasText: 'Individual' }).waitFor());
      expect(await page.locator('#org-subscription').innerText()).toMatch(/individual\s+active/i);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 90_000);
});
