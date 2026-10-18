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
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { MANAGED_COMPUTE, WorldProviderConnectionService } from '../src/world/connections.js';

it('adds and removes storage and compute packs in Plan & billing, showing only verified packs', async () => {
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
  const verified = (packs: number, compute = 0) => billing.handleWebhook(Buffer.from(JSON.stringify({
    id: `browser-pack-${++sequence}`, created: sequence, type: 'customer.subscription.updated', data: { object: {
      id: 'sub_browser_packs', customer: `cus_${org.id}`, status: 'active',
      items: { data: [{ id: 'si_base', price: { id: 'price_team_base' }, quantity: 1 },
        ...(packs ? [{ id: 'si_pack', price: { id: 'price_storage_pack' }, quantity: packs }] : []),
        ...(compute ? [{ id: 'si_compute', price: { id: 'price_compute_pack' }, quantity: compute }] : [])] },
    } },
  })));
  await verified(0);
  // The installation runs E2B computers, so compute shows beside storage.
  const providerConnections = new WorldProviderConnectionService(store, new CredentialBroker(new Vault(path.join(directory, 'vault'))),
    { check: async () => {}, limits: async () => ({}) });
  await providerConnections.save({ organizationId: MANAGED_COMPUTE, provider: 'e2b', apiKey: 'operator-key', config: { maxRunning: 20 } });
  await store.recordUsage({ id: 'usage:e2b:browser', organizationId: org.id, provider: 'e2b', kind: 'world.active', quantity: 3600,
    unit: 'second', costMicros: 1_500_000, startedAt: Date.now() - 3_700_000, endedAt: Date.now() - 100_000, fundingSource: 'managed' });
  const worlds = new WorldRegistry(), tokens = new TokenAuthority();
  const client = { workflow: { getHandle: () => ({ query: async () => [] }) } } as any;
  const api = new KarmaxApi({ store, tokens, worlds, client, taskQueue: 'test', contentDir: directory });
  const authorization = await AuthorizationService.create(store);
  await authorization.bootstrapOrganizationOwner('system:test', user.id, org.id);
  const gateway = await Gateway.create({ store, tokens, worlds, client, api, hosted: true, identity,
    authorization, subscriptions: billing, providerConnections,
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
    const plan = page.locator('#org-plan');
    expect(await plan.locator('.plan-head').innerText()).toMatch(/Team\s+\$19\/month/);
    // Storage and compute, each against its limit; this month's compute at twice E2B's price.
    expect(await plan.locator('[data-limit="storage"]').innerText()).toMatch(/0 B\s+of 100 GB/);
    expect(await plan.locator('[data-limit="compute"]').innerText()).toMatch(/\$3\.00\s+of \$10\.00 this month/);
    expect(await plan.locator('[data-limit="storage"] .pack-stepper').getAttribute('title')).toBe('Each pack adds 100 GB for $4/month');

    await add.click();
    await expect.poll(() => provider.calls.filter(call => call.method === 'updateStoragePacks').length).toBe(1);
    expect(dialogs.at(-1)).toBe('Add 100 GB for $4/month?');
    expect(provider.calls.at(-1)?.input).toMatchObject({ subscriptionId: 'sub_browser_packs', storagePacks: 1 });
    // The click alone grants nothing; the signed subscription state does.
    expect((await store.organizationEntitlements(org.id)).storagePacks).toBe(0);

    await page.getByRole('button', { name: 'Add a compute pack' }).click();
    await expect.poll(() => provider.calls.filter(call => call.method === 'updateComputePacks').length).toBe(1);
    expect(dialogs.at(-1)).toBe('Add $10.00 of compute a month for $10/month?');
    expect(provider.calls.at(-1)?.input).toMatchObject({ subscriptionId: 'sub_browser_packs', computePacks: 1 });

    await verified(2, 1);
    await page.reload();
    await plan.locator('.plan-head').getByText('$37/month', { exact: false }).waitFor();
    expect(await plan.locator('[data-limit="storage"]').innerText()).toMatch(/of 300 GB\s+−\s+2\s+\+\s+packs/);
    expect(await plan.locator('[data-limit="compute"]').innerText()).toMatch(/\$3\.00\s+of \$20\.00 this month\s+−\s+1\s+\+\s+pack/);
    expect(await plan.locator('[data-limit="storage"] .info-dot').getAttribute('title')).toContain('100 GB with Team + 200 GB in 2 packs');
    if (process.env.KARMAX_REVIEW_SCREENSHOT) await page.locator('#settings-billing').screenshot({ path: process.env.KARMAX_REVIEW_SCREENSHOT });

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
