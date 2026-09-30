import { expect, it } from 'vitest';
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
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
import { CredentialBroker } from '../src/autonomy/broker.js';
import { Vault } from '../src/autonomy/vault.js';
import { PaidLaunchSettingsService } from '../src/launch/settings.js';
import { PaddleSubscriptionProvider } from '../src/billing/paddle.js';
import { SubscriptionBillingService } from '../src/billing/subscriptions.js';

it('serves token-only checkout, verifies raw HTTP webhooks, and keeps payment completion visible', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paddle-browser-'));
  const store = await Store.create(':memory:', { hosted: true });
  const broker = new CredentialBroker(new Vault(path.join(directory, 'vault')));
  const settings = new PaidLaunchSettingsService(store, broker, {});
  const paddle = { environment: 'sandbox', apiKey: 'pdl_sdbx_apikey_secret', webhookSecret: 'pdl_ntfset_secret',
    clientToken: 'test_public', individualPriceId: `pri_${'a'.repeat(26)}`, teamBasePriceId: `pri_${'b'.repeat(26)}`, teamSeatPriceId: `pri_${'c'.repeat(26)}` };
  await settings.configure({ billingProvider: 'paddle', paddle }, 'https://tavya.test');
  const billing = new SubscriptionBillingService(store, new PaddleSubscriptionProvider(() => settings.paddleConfig()), true);
  const worlds = new WorldRegistry(), tokens = new TokenAuthority();
  const authorization = await AuthorizationService.create(store);
  const client = { workflow: { getHandle: () => ({ query: async () => [] }) } } as any;
  const api = new KarmaxApi({ store, tokens, worlds, client, taskQueue: 'test', contentDir: directory });
  const gateway = await Gateway.create({ store, tokens, worlds, client, api, authorization, subscriptions: billing,
    paidLaunchSettings: settings, password: 'require-auth', taskQueue: 'test', staticDir: path.resolve('web'),
    bus: new KarmaxBus(), contributions: new ContributionRegistry(), overlays: new Overlays(),
    agentInfo: { provider: 'mock', reason: 'Paddle browser test' } });
  const server = await gateway.listen(await findFreePortFrom(48850));
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'],
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
  try {
    const checkoutResponse = await fetch(`${server.url}/billing/checkout`);
    expect(checkoutResponse.headers.get('content-security-policy')).toContain("script-src 'self' https://cdn.paddle.com");
    const configResponse = await fetch(`${server.url}/api/subscriptions/paddle/checkout-config`);
    expect(configResponse.headers.get('cache-control')).toBe('no-store');
    expect(await configResponse.json()).toEqual({ environment: 'sandbox', clientToken: 'test_public' });
    const raw = JSON.stringify({ event_id: 'evt_browser', event_type: 'transaction.updated', occurred_at: new Date().toISOString(), data: {} });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = `ts=${timestamp};h1=${crypto.createHmac('sha256', paddle.webhookSecret).update(`${timestamp}:${raw}`).digest('hex')}`;
    const url = `${server.url}/api/subscriptions/paddle/webhook`;
    expect((await fetch(url, { method: 'POST', body: raw })).status).toBe(400);
    expect(await (await fetch(url, { method: 'POST', body: raw, headers: { 'paddle-signature': signature } })).json()).toMatchObject({ received: true, duplicate: false });
    expect(await (await fetch(url, { method: 'POST', body: raw, headers: { 'paddle-signature': signature } })).json()).toMatchObject({ duplicate: true });
    expect((await fetch(url, { method: 'POST', body: raw + ' ', headers: { 'paddle-signature': signature } })).status).toBe(400);
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://cdn.paddle.com/**', route => route.fulfill({ contentType: 'application/javascript', body: `
      window.Paddle = { Environment: { set: v => window.paddleEnvironment = v },
        Initialize: options => { window.paddleOptions = options; }, Checkout: { open: () => {} } };` }));
    await page.goto(`${server.url}/billing/checkout?_ptxn=txn_${'a'.repeat(26)}`);
    await page.getByText('Test checkout — no real payment.').waitFor();
    expect(await page.evaluate(() => (globalThis as any).paddleEnvironment)).toBe('sandbox');
    expect(await page.evaluate(() => (globalThis as any).paddleOptions.token)).toBe('test_public');
    await page.evaluate(() => {
      const callback = (globalThis as any).paddleOptions.eventCallback;
      callback({ name: 'checkout.completed' }); callback({ name: 'checkout.closed' }); callback({ name: 'checkout.error' });
    });
    expect(await page.locator('#checkout-status').innerText()).toContain('Payment received');
    expect(await page.locator('#checkout-retry').isHidden()).toBe(true);
    await page.goto(`${server.url}/billing/checkout?_ptxn=txn_${'a'.repeat(26)}&success=https://attacker.test/`);
    await page.getByText('Test checkout — no real payment.').waitFor();
    await page.evaluate(() => (globalThis as any).paddleOptions.eventCallback({ name: 'checkout.completed' }));
    expect(new URL(page.url()).origin).toBe(server.url);
    expect(await page.locator('#checkout-status').innerText()).toContain('Payment received');
    await page.route('**/checkout-return', route => route.fulfill({ contentType: 'text/html', body: '<p>Returned</p>' }));
    await page.goto(`${server.url}/billing/checkout?_ptxn=txn_${'a'.repeat(26)}&success=${encodeURIComponent(server.url + '/checkout-return')}`);
    await page.getByText('Test checkout — no real payment.').waitFor();
    await page.evaluate(() => (globalThis as any).paddleOptions.eventCallback({ name: 'checkout.completed' }));
    await page.waitForURL('**/checkout-return');
    await page.goto(`${server.url}/billing/checkout?_ptxn=invalid`);
    await page.getByText('Start checkout from your organization’s Plan & billing settings.').waitFor();
    expect(errors).toEqual([]);
  } finally {
    await browser.close(); await server.close(); await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
