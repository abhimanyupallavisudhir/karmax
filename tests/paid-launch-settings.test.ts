import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { Vault } from '../src/autonomy/vault.js';
import { StripeSubscriptionProvider } from '../src/billing/subscriptions.js';
import { STRIPE_BILLING_API_VERSION, STRIPE_BILLING_WEBHOOK_EVENTS } from '../src/billing/stripe-contract.js';
import { POLICY_VERSION } from '../src/launch/legal.js';
import { FOUNDER_TASKS, PAID_LAUNCH_SETTINGS_KEY, PaidLaunchSettingsService,
  SUBSCRIPTION_STRIPE_SECRET_HANDLE, SUBSCRIPTION_STRIPE_WEBHOOK_HANDLE } from '../src/launch/settings.js';
import { Store } from '../src/store/db.js';

const dirs: string[] = [];
const harness = async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-paid-launch-'));
  dirs.push(dir);
  const store = (await Store.create(':memory:'));
  const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
  return { store, broker, service: new PaidLaunchSettingsService(store, broker, {}) };
};

afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const complete = (enabled = true) => ({
  paidLaunch: enabled, founderReviewed: true,
  operatorName: 'Krmax Labs Ltd', operatorCountry: 'United Kingdom',
  governingLaw: 'Laws of England and Wales; courts of England and Wales',
  legalNoticeAddress: '1 Example Street, London',
  contacts: { legal: 'legal@krmax.test', privacy: 'privacy@krmax.test', security: 'security@krmax.test',
    incident: 'incident@krmax.test', dpa: 'dpa@krmax.test', billing: 'billing@krmax.test' },
  stripe: { secretKey: 'sk_live_billing', webhookSecret: 'whsec_billing',
    individualPriceId: 'price_individual', teamBasePriceId: 'price_team', teamSeatPriceId: 'price_seat',
    individualProductId: 'prod_individual', teamProductId: 'prod_team' },
  completedTasks: ['business-structure', 'stripe-account'],
});

describe('installation paid-launch settings', () => {
  it('never carries bootstrap secrets or prices into a different Paddle environment', async () => {
    const { store, broker } = await harness();
    const service = new PaidLaunchSettingsService(store, broker, {
      KARMAX_SUBSCRIPTION_PADDLE_ENVIRONMENT: 'sandbox', KARMAX_SUBSCRIPTION_PADDLE_API_KEY: 'pdl_sdbx_apikey_bootstrap',
      KARMAX_SUBSCRIPTION_PADDLE_CLIENT_TOKEN: 'test_bootstrap', KARMAX_SUBSCRIPTION_PADDLE_INDIVIDUAL_PRICE_ID: `pri_${'a'.repeat(26)}`,
    });
    await service.configure({ billingProvider: 'paddle', paddle: { environment: 'live' } }, 'https://tavya.test');
    expect(await service.paddleConfig()).toMatchObject({ environment: 'live', apiKey: undefined, clientToken: undefined, individualPriceId: undefined });
    await store.close();
  });
  it('stores Paddle secrets only in the vault and refuses sandbox as live checkout', async () => {
    const { store, service } = await harness();
    const id = (letter: string) => `pri_${letter.repeat(26)}`;
    const input = { ...complete(false), billingProvider: 'paddle', paddle: {
      environment: 'sandbox', apiKey: 'pdl_sdbx_apikey_secret', webhookSecret: 'pdl_ntfset_secret',
      clientToken: 'test_public', individualPriceId: id('a'), teamBasePriceId: id('b'), teamSeatPriceId: id('c'),
    } };
    const result = await service.configure(input, 'https://tavya.test');
    expect(result).toMatchObject({ billingProvider: 'paddle', canEnable: false,
      paddle: { configured: true, webhookUrl: 'https://tavya.test/api/subscriptions/paddle/webhook' } });
    expect(JSON.stringify(result)).not.toContain('pdl_sdbx_apikey_secret');
    expect(JSON.stringify(result)).not.toContain('pdl_ntfset_secret');
    expect(await store.kvGet(PAID_LAUNCH_SETTINGS_KEY)).not.toContain('pdl_ntfset_secret');
    await expect(service.configure({ ...input, paidLaunch: true }, 'https://tavya.test')).rejects.toThrow(/live environment/);
    await expect(service.configure({ ...input, paddle: { ...input.paddle, environment: 'live' } }, 'https://tavya.test'))
      .rejects.toThrow(/environment/);
    const live = await service.configure({ ...input, paddle: { environment: 'live' } }, 'https://tavya.test');
    expect(live.paddle).toMatchObject({ configured: false, secretKeyConfigured: false, webhookSecretConfigured: false });
    expect(live.paddle.individualPriceId).toBeUndefined();
    await store.close();
  });
  it('persists public configuration and checklist while keeping Stripe secrets in the vault', async () => {
    const { store, broker, service } = (await harness());
    const result = (await service.configure(complete(), 'https://krmax.test'));
    expect(result).toMatchObject({ paidLaunch: true, ready: true, canEnable: true,
      founderReviewed: true, completedTasks: ['business-structure', 'stripe-account'],
      stripe: { configured: true, secretKeyConfigured: true, webhookSecretConfigured: true,
        webhookUrl: 'https://krmax.test/api/subscriptions/webhook', apiVersion: STRIPE_BILLING_API_VERSION,
        webhookEvents: STRIPE_BILLING_WEBHOOK_EVENTS } });
    expect(result.tasks).toHaveLength(FOUNDER_TASKS.length);
    expect((await store.kvGet(PAID_LAUNCH_SETTINGS_KEY))).not.toContain('sk_live_billing');
    expect((await store.kvGet(PAID_LAUNCH_SETTINGS_KEY))).not.toContain('whsec_billing');
    expect(broker.hasHandle(SUBSCRIPTION_STRIPE_SECRET_HANDLE)).toBe(true);
    expect(broker.hasHandle(SUBSCRIPTION_STRIPE_WEBHOOK_HANDLE)).toBe(true);
    expect((await service.publicLaunchInfo())).toMatchObject({ paidLaunch: true, ready: true,
      operator: { name: 'Krmax Labs Ltd', country: 'United Kingdom' } });
    expect((await service.stored()).founderReviewedPolicyVersion).toBe(POLICY_VERSION);
    (await store.close());
  });

  it('saves an incomplete draft but refuses to enable checkout', async () => {
    const { store, service } = (await harness());
    await expect((async () => (await service.configure({ paidLaunch: true, operatorName: 'Draft' }, 'https://krmax.test')))()).rejects.toThrow(/cannot be enabled.*Founder approval.*Stripe secret key/i);
    expect((await service.status('https://krmax.test'))).toMatchObject({ paidLaunch: false, canEnable: false,
      operatorName: 'Draft' });
    (await store.close());
  });

  it('updates a live Stripe provider immediately without a restart', async () => {
    const { store, service } = (await harness());
    const provider = new StripeSubscriptionProvider(async () => (await service.subscriptionConfig()));
    expect((await provider.configured())).toBe(false);
    (await service.configure(complete(false), 'https://krmax.test'));
    expect((await provider.configured())).toBe(true);
    expect((await provider.catalog())).toEqual({ individualPriceId: 'price_individual', teamBasePriceId: 'price_team',
      teamSeatPriceId: 'price_seat', individualProductId: 'prod_individual', teamProductId: 'prod_team' });
    (await store.close());
  });
});
