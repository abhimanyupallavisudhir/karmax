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

it('adds and removes storage packs from Subscription billing, showing only verified packs', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-packs-browser-'));
  const port = await findFreePortFrom(48860);
  const identity = await IdentityService.open(':memory:', { baseURL: `http://127.0.0.1:${port}` });
  const user = await identity.createUser({ name: 'Pack owner', email: 'pack-owner@example.test', password: 'long-fixture-password' });
  const store = await Store.create(':memory:', { hosted: true });
  const org = await store.createOrganization({ name: 'Storage workspace', ownerUserId: user.id });
  const provider = new FakeSubscriptionProvider();
  const billing = new SubscriptionBillingService(store, provider, true);
  await billing.checkout(org.id, 'team', { success: 'https://test/s', cancel: 'https://test/c' }, 'browser-pack-checkout');
  let sequence = 100;
  const verified = (packs: number) => billing.handleWebhook(Buffer.from(JSON.stringify({
    id: `browser-pack-${++sequence}`, created: sequence, type: 'customer.subscription.updated', data: { object: {
      id: 'sub_browser_packs', customer: `cus_${org.id}`, status: 'active',
      items: { data: [{ id: 'si_base', price: { id: 'price_team_base' }, quantity: 1 },
        ...(packs ? [{ id: 'si_pack', price: { id: 'price_storage_pack' }, quantity: packs }] : [])] },
    } },
  })));
  await verified(0);
  const worlds = new WorldRegistry(), tokens = new TokenAuthority();
  const client = { workflow: { getHandle: () => ({ query: async () => [] }) } } as any;
  const api = new KarmaxApi({ store, tokens, worlds, client, taskQueue: 'test', contentDir: directory });
  const authorization = await AuthorizationService.create(store);
  await authorization.bootstrapOrganizationOwner('system:test', user.id, org.id);
  const gateway = await Gateway.create({ store, tokens, worlds, client, api, hosted: true, identity,
    authorization, subscriptions: billing,
    taskQueue: 'test', staticDir: path.resolve('web'), bus: new KarmaxBus(), contributions: new ContributionRegistry(),
    overlays: new Overlays(), agentInfo: { provider: 'mock', reason: 'storage pack browser test' } });
  const server = await gateway.listen(port);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ serviceWorkers: 'block' });
    const errors: string[] = [];
    const dialogs: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.accept(); });
    expect((await page.request.post(`${server.url}/api/auth/sign-in/email`, {
      headers: { origin: server.url, 'x-forwarded-for': '192.0.2.181' }, data: { email: user.email, password: 'long-fixture-password' },
    })).status()).toBe(200);
    await page.goto(`${server.url}/${org.slug}/settings#settings-billing`);
    const add = page.getByRole('button', { name: 'Add a storage pack' });
    const remove = page.getByRole('button', { name: 'Remove a storage pack' });
    await add.waitFor({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Close setup guide' }).click();
    expect(await remove.isDisabled()).toBe(true);
    expect(await page.locator('#org-subscription').innerText()).toContain('$4/month each');

    await add.click();
    await expect.poll(() => provider.calls.filter(call => call.method === 'updateStoragePacks').length).toBe(1);
    expect(dialogs.at(-1)).toBe('Add a 100 GB storage pack for $4/month?');
    expect(provider.calls.at(-1)?.input).toMatchObject({ subscriptionId: 'sub_browser_packs', storagePacks: 1 });
    // The click alone grants nothing; the signed subscription state does.
    expect((await store.organizationEntitlements(org.id)).storagePacks).toBe(0);
    await verified(2);
    await page.reload();
    await page.locator('#org-subscription').getByText('$8/month', { exact: true }).waitFor();
    if (process.env.KARMAX_REVIEW_SCREENSHOT) await page.locator('#org-subscription').screenshot({ path: process.env.KARMAX_REVIEW_SCREENSHOT });

    await remove.click();
    await expect.poll(() => provider.calls.filter(call => call.method === 'updateStoragePacks').length).toBe(2);
    expect(provider.calls.at(-1)?.input).toMatchObject({ storagePacks: 1 });
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await server.close();
    await identity.close();
    await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
