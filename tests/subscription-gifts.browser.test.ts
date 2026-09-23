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
    await page.getByRole('combobox', { name: 'Gift subscription' }).selectOption('individual');
    await page.getByRole('button', { name: 'Gift', exact: true }).click();
    await page.locator('#org-plan .section-h').filter({ hasText: 'Individual' }).waitFor();
    expect(await page.locator('#org-plan .chip').textContent()).toBe('Gifted');
    expect((await store.organizationEntitlements(recipient.id)).maxActiveAgentRuns).toBe(10);
    await page.getByRole('combobox', { name: 'Gift subscription' }).selectOption('team');
    await page.getByRole('button', { name: 'Update gift', exact: true }).click();
    await page.locator('#org-plan .section-h').filter({ hasText: 'Team' }).waitFor();
    expect((await store.organizationEntitlements(recipient.id)).maxActiveAgentRuns).toBe(20);
    expect(provider.calls).toHaveLength(0);
    await store.setOrganizationMembership(recipient.id, 'second-member', 'member');
    await page.reload();
    await page.getByRole('button', { name: 'Update gift', exact: true }).waitFor();
    expect(await page.locator('#org-plan input').nth(2).inputValue()).toBe('25 active agent runs');
    expect(await page.locator('#org-subscription').textContent()).toContain('Gifted · no expiry');
    expect(await page.locator('.billing-checkout').count()).toBe(0);
    if (process.env.KARMAX_REVIEW_SCREENSHOT) await page.locator('#org-subscription').screenshot({ path: process.env.KARMAX_REVIEW_SCREENSHOT });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Remove gift', exact: true }).click();
    await page.locator('#org-plan .section-h').filter({ hasText: 'Free' }).waitFor();
    expect((await billing.current(recipient.id)).gift).toBeNull();
    expect(await page.locator('#org-plan').innerText()).toContain('Agent runs are paused');

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
    await page.locator('#org-subscription .section-h').first().waitFor();
    await expect.poll(() => page.getByRole('combobox', { name: 'Gift subscription' }).count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await server.close();
    await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
