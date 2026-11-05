import { expect, it } from 'vitest';
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { Gateway } from '../src/gateway/server.js';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { AuthorizationService } from '../src/platform/authorization.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { WorldRegistry } from '../src/world/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { findFreePortFrom } from '../src/util/ports.js';
import { FakeSubscriptionProvider, SubscriptionBillingService } from '../src/billing/subscriptions.js';
import { IdentityService } from '../src/auth/identity.js';

it('gifts, changes, and removes plans from the organization billing screen through the real API', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'subscription-gift-browser-'));
  const store = await Store.create(':memory:', { hosted: true });
  const recipient = await store.createOrganization({ name: 'Gift recipient', ownerUserId: 'someone-else' });
  const provider = new FakeSubscriptionProvider();
  provider.configured = () => false;
  const billing = new SubscriptionBillingService(store, provider, true);
  const worlds = new WorldRegistry(), tokens = new TokenAuthority();
  const authorization = await AuthorizationService.create(store);
  const client = { workflow: { getHandle: () => ({ query: async () => [] }) } } as any;
  const api = new KarmaxApi({ store, tokens, worlds, client, taskQueue: 'test', contentDir: directory });
  const gateway = await Gateway.create({ store, tokens, worlds, client, api, authorization, subscriptions: billing,
    taskQueue: 'test', staticDir: path.resolve('web'), bus: new KarmaxBus(), contributions: new ContributionRegistry(),
    overlays: new Overlays(), agentInfo: { provider: 'mock', reason: 'gift browser test' } });
  const server = await gateway.listen(await findFreePortFrom(48830));
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ serviceWorkers: 'block' });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.goto(`${server.url}/${recipient.slug}/settings#settings-plan`);
    const plan = page.locator('#org-plan');
    await plan.locator('.plan-operator > summary').click();
    await page.getByRole('combobox', { name: 'Gift plan' }).selectOption('individual');
    await page.getByRole('button', { name: 'Gift', exact: true }).click();
    await plan.locator('.plan-name').filter({ hasText: 'Individual' }).waitFor();
    expect(await plan.locator('.plan-head .chip').textContent()).toBe('Gifted');
    expect((await store.organizationEntitlements(recipient.id)).maxActiveAgentRuns).toBe(10);
    await page.getByRole('combobox', { name: 'Gift plan' }).selectOption('team');
    // A gifted Team covers the seats gifted with it.
    await page.getByRole('spinbutton', { name: 'Gifted seats' }).fill('2');
    await page.getByRole('button', { name: 'Update', exact: true }).click();
    await plan.locator('.plan-name').filter({ hasText: 'Team' }).waitFor();
    expect((await store.organizationEntitlements(recipient.id)).maxActiveAgentRuns).toBe(20);
    expect((await billing.currentGift(recipient.id))?.seats).toBe(2);
    await plan.locator('[data-limit="people"]').getByText('1 of 2 seats').waitFor();
    expect(provider.calls).toHaveLength(0);
    await store.setOrganizationMembership(recipient.id, 'second-member', 'member');
    await page.reload();
    await plan.locator('.plan-operator > summary').click();
    await page.getByRole('button', { name: 'Update', exact: true }).waitFor();
    expect(await plan.locator('.plan-limits').innerText()).toMatch(/25 at once/);
    expect(await page.locator('.billing-checkout').count()).toBe(0);
    // Gifted storage and compute packs: any plan, no billing provider; the tooltip says where the storage comes from.
    await page.getByRole('spinbutton', { name: 'Gifted storage packs' }).fill('2');
    await plan.locator('.billing-gift-packs[data-kind="storage"]').click();
    await expect.poll(async () => (await store.organizationEntitlements(recipient.id)).storageQuotaBytes).toBe(310 * 1024 ** 3);
    await plan.locator('[data-limit="storage"]').filter({ hasText: 'of 310 GB' }).waitFor();
    expect(await plan.locator('[data-limit="storage"] .info-dot').getAttribute('title')).toContain('110 GB with Team + 2 × 100 GB packs gifted');
    await page.getByRole('spinbutton', { name: 'Gifted compute packs' }).fill('1');
    await plan.locator('.billing-gift-packs[data-kind="compute"]').click();
    await expect.poll(async () => (await store.organizationEntitlements(recipient.id)).giftedComputePacks).toBe(1);
    expect((await store.organizationEntitlements(recipient.id)).computeCreditMicros).toBe(13_000_000 + 10_000_000);
    expect(provider.calls).toHaveLength(0);
    // The card re-renders after each save; typing before that is thrown away.
    await expect.poll(() => plan.locator('.billing-gift-packs[data-kind="compute"]').isEnabled()).toBe(true);
    if (process.env.KARMAX_REVIEW_SCREENSHOT) await page.locator('#org-plan').screenshot({ path: process.env.KARMAX_REVIEW_SCREENSHOT });
    await page.getByRole('spinbutton', { name: 'Gifted storage packs' }).fill('0');
    await plan.locator('.billing-gift-packs[data-kind="storage"]').click();
    await expect.poll(async () => (await store.organizationEntitlements(recipient.id)).giftedStoragePacks).toBe(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await plan.locator('.plan-name').filter({ hasText: 'Free' }).waitFor();
    expect((await billing.current(recipient.id)).gift).toBeNull();
    expect(await plan.innerText()).toContain('over the limit: agents are paused');
    // Free: the plan choices say what each plan includes.
    expect(await plan.locator('.plan-choice[data-plan="individual"]').innerText()).toContain('50 GB storage');

    // Render using a real, attenuated API token: ordinary organization admins
    // may read the gift, but the server never advertises gift controls to them.
    const ordinary = await tokens.mintPrincipal('user:someone-else', ['organization:*', 'payment:*'], undefined, undefined, recipient.id);
    await page.route('**/subscription/status', async route => {
      const response = await page.request.get(route.request().url(), {
        headers: { authorization: `Bearer ${ordinary.token}` },
      });
      const body = await response.json();
      expect(body.canGift).toBe(false);
      await route.fulfill({ json: body });
    });
    await page.reload();
    await page.locator('#org-plan .plan-name').first().waitFor();
    await expect.poll(() => page.locator('#org-plan .plan-operator').count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await server.close();
    await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);

it('opens a purchased subscription from the profile and upgrades or cancels it in Subscription billing', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'subscription-management-browser-'));
  const port = await findFreePortFrom(48830);
  const identity = await IdentityService.open(':memory:', { baseURL: `http://127.0.0.1:${port}` });
  const user = await identity.createUser({ name: 'Billing owner', email: 'billing-owner@example.test', password: 'long-fixture-password' });
  const store = await Store.create(':memory:', { hosted: true });
  const org = await store.createOrganization({ name: 'Purchased workspace', ownerUserId: user.id });
  const provider = new FakeSubscriptionProvider();
  const billing = new SubscriptionBillingService(store, provider, true);
  const checkout = await billing.checkout(org.id, 'individual', { success: 'https://test/s', cancel: 'https://test/c' }, 'browser-purchase');
  await store.recordPolicyAcceptance({ userId: user.id, organizationId: org.id, context: 'checkout', versions: {},
    checkoutSessionReference: checkout.checkoutSessionReference });
  let sequence = 100;
  const subscription = async (plan: 'individual' | 'team', cancel = false) => billing.handleWebhook(Buffer.from(JSON.stringify({
    id: `browser-${++sequence}`, created: sequence, type: 'customer.subscription.updated', data: { object: {
      id: 'sub_browser', customer: `cus_${org.id}`, status: 'active', cancel_at_period_end: cancel,
      current_period_end: Math.floor(Date.now() / 1000) + 86_400,
      items: { data: [{ id: 'si', price: { id: plan === 'team' ? 'price_team_base' : 'price_individual' }, quantity: 1 }] },
    } },
  })));
  await subscription('individual');
  await billing.handleWebhook(Buffer.from(JSON.stringify({ id: 'browser-checkout', created: ++sequence,
    type: 'checkout.session.completed', data: { object: { id: checkout.checkoutSessionReference,
      subscription: 'sub_browser', customer: `cus_${org.id}` } } })));
  const worlds = new WorldRegistry(), tokens = new TokenAuthority();
  const client = { workflow: { getHandle: () => ({ query: async () => [] }) } } as any;
  const api = new KarmaxApi({ store, tokens, worlds, client, taskQueue: 'test', contentDir: directory });
  const authorization = await AuthorizationService.create(store);
  await authorization.bootstrapOrganizationOwner('system:test', user.id, org.id);
  const gateway = await Gateway.create({ store, tokens, worlds, client, api, hosted: true, identity,
    authorization, subscriptions: billing,
    taskQueue: 'test', staticDir: path.resolve('web'), bus: new KarmaxBus(), contributions: new ContributionRegistry(),
    overlays: new Overlays(), agentInfo: { provider: 'mock', reason: 'subscription management browser test' } });
  const server = await gateway.listen(port);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ serviceWorkers: 'block' });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    const login = await page.request.post(`${server.url}/api/auth/sign-in/email`, {
      // Better Auth's in-memory limiter is shared across identity instances.
      // Give this fixture its own client address without disabling throttling.
      headers: { origin: server.url, 'x-forwarded-for': '192.0.2.173' }, data: { email: user.email, password: 'long-fixture-password' },
    });
    expect(login.status()).toBe(200);
    await page.goto(`${server.url}/profile`);
    await page.locator('#profile-paid-subscriptions').getByText(org.name, { exact: true }).waitFor({ timeout: 10_000 }).catch(async error => {
      throw new Error(`${error.message}\nPage: ${await page.locator('body').innerText()}\nErrors: ${errors.join('; ')}`);
    });
    expect(await page.locator('#profile-paid-subscriptions').innerText()).not.toContain('no longer have billing-management access');
    expect((await fetch(`${server.url}/api/user/paid-subscriptions`)).status).toBe(401);
    const otherUser = await identity.createUser({ name: 'Other user', email: 'other-billing@example.test', password: 'long-fixture-password' });
    const otherContext = await browser.newContext();
    try {
      expect((await otherContext.request.post(`${server.url}/api/auth/sign-in/email`, {
        headers: { origin: server.url, 'x-forwarded-for': '192.0.2.174' }, data: { email: otherUser.email, password: 'long-fixture-password' },
      })).status()).toBe(200);
      const otherList = await otherContext.request.get(`${server.url}/api/user/paid-subscriptions?userId=${user.id}`);
      expect(otherList.status()).toBe(200);
      expect(await otherList.json()).toEqual({ subscriptions: [] });
    } finally { await otherContext.close(); }
    await page.locator('#profile-paid-subscriptions').getByRole('link', { name: 'Plans & billing' }).click();
    await page.getByRole('button', { name: 'Close setup guide' }).click({ timeout: 10_000 }).catch(() => undefined);
    await page.getByRole('button', { name: 'Upgrade to Team', exact: true }).click({ timeout: 10_000 }).catch(async error => {
      throw new Error(`${error.message}\nURL: ${page.url()}\nPage: ${await page.locator('body').innerText()}\nErrors: ${errors.join('; ')}`);
    });
    await expect.poll(() => provider.calls.filter(call => call.method === 'changePlan').length).toBe(1);
    expect(provider.calls.find(call => call.method === 'changePlan')?.input.plan).toBe('team');
    // Provider confirmation, not a click alone, changes the displayed plan.
    await subscription('team');
    await page.reload();
    await page.getByRole('button', { name: 'Switch to Individual', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Cancel plan', exact: true }).click();
    await expect.poll(() => provider.calls.filter(call => call.method === 'cancelAtPeriodEnd').length).toBe(1);
    await subscription('team', true);
    await page.reload();
    await page.locator('#org-plan .plan-head .chip').filter({ hasText: /^Ends / }).waitFor();
    expect(await page.getByRole('button', { name: 'Cancel plan', exact: true }).count()).toBe(0);
    // A portal session is fetched only after an explicit user action.
    await page.route('https://portal.test/**', route => route.fulfill({ body: 'Test billing portal' }));
    await page.getByRole('button', { name: 'Billing', exact: true }).click();
    await page.waitForURL('https://portal.test/session');
    expect(provider.calls.filter(call => call.method === 'createPortal')).toHaveLength(1);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await server.close();
    await identity.close();
    await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
