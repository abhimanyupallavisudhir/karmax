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
