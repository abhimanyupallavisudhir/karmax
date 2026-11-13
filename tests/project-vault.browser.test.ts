// A project's Passwords card (wiki features/vault-encryption, features/settings-design):
// a Project maintainer — who holds no organization vault authority — sees the
// project's own credentials and the organization's its tasks may use, manages
// and views only the project's own, and adds new ones to the project.
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { VaultItems } from '../src/autonomy/vault-items.js';
import { organizationScope, projectScope } from '../src/platform/authorization.js';
import { policyVersions } from '../src/launch/legal.js';
import { hostedOnboardingKey } from '../src/gateway/hosted-onboarding.js';
import { hostedGateway, launchChromium, openConsole, signIn, type HostedGateway } from './helpers/browser.js';

let browser: Browser, g: HostedGateway;
const PASSWORD = 'correct horse battery staple 42';

beforeAll(async () => {
  browser = await launchChromium();
  g = await hostedGateway();
}, 60_000);
afterAll(async () => { await g?.close(); await browser?.close(); });

it('lets a Project maintainer manage the project’s own credentials beside the organization’s', async () => {
  const { organization } = await g.owner({ name: 'Ada', email: 'ada@example.test', password: PASSWORD, organization: 'Shops Inc' });
  const shop = await g.store.createProject('Shop', {}, organization.id);
  const lab = await g.store.createProject('Lab', {}, organization.id);
  await g.store.setOrganizationPlan(organization.id, 'team');
  const maintainer = await g.identity.createUser({ name: 'Mo', email: 'mo@example.test', password: PASSWORD });
  await g.store.setOrganizationMembership(organization.id, maintainer.id, 'member');
  // A member who reads the organization and maintains one project of it.
  await g.authorization.grant('system:test', { principalId: `user:${maintainer.id}`, scopeKey: organizationScope(organization.id), profileId: 'viewer' });
  await g.authorization.grant('system:test', { principalId: `user:${maintainer.id}`, scopeKey: projectScope(shop.id), profileId: 'maintainer' });
  await g.store.recordPolicyAcceptance({ userId: maintainer.id, context: 'signup', versions: policyVersions('signup') });
  await g.store.kvSet(hostedOnboardingKey(maintainer.id, organization.id), JSON.stringify({ display: 'closed' }));
  const vault = new VaultItems(g.store, g.broker, g.directory, organization.id);
  const shared = await vault.save({ type: 'login', label: 'Stripe dashboard', domains: ['stripe.com'], secrets: { password: 'org-secret' } });
  const own = await vault.save({ type: 'api-key', label: 'Shop API key', envVar: 'SHOP_KEY', ownerProjectId: shop.id, secrets: { secret: 'shop-secret' } });
  await vault.save({ type: 'note', label: 'Lab notes', ownerProjectId: lab.id, secrets: { note: 'lab-secret' } });

  const { page, errors, step, context } = await openConsole(browser, { ip: '192.0.2.61', viewport: { width: 1280, height: 900 } });
  try {
    await signIn(context, g.url, 'mo@example.test', PASSWORD);
    await step('open the project’s Passwords & payments', () => page.goto(`${g.url}/${organization.slug}/shop/settings#project-payments`));
    const card = page.locator('#vault-card');
    await step('the card counts the project’s and the organization’s, never another project’s', () =>
      card.locator('#vault-manage-open').getByText('2 items').waitFor());
    await step('it imports nothing: password managers are the organization’s', async () => {
      expect(await card.locator('.bitwarden-file-import').count()).toBe(0);
      expect(await page.locator('#project-connections').count()).toBe(1);
    });
    if (process.env.KARMAX_SCREENSHOT_DIR) await card.screenshot({ path: `${process.env.KARMAX_SCREENSHOT_DIR}/project-vault-card.png` });
    await card.locator('#vault-manage-open').click();
    const ownRow = page.locator(`[data-vi="${own.id}"]`);
    const sharedRow = page.locator(`[data-vi="${shared.id}"]`);
    await step('the organization’s is marked and read-only; the project’s own is the maintainer’s', async () => {
      await ownRow.waitFor();
      await expect.poll(() => sharedRow.locator('.vm-owner').textContent()).toBe('organization');
      expect(await ownRow.locator('.vm-owner').count()).toBe(0);
      expect(await sharedRow.locator('.vi-pol-use').isDisabled()).toBe(true);
      expect(await sharedRow.locator('[data-vi-del]').count()).toBe(0);
      expect(await sharedRow.locator('[data-vi-reveal]').isDisabled()).toBe(true);
      expect(await ownRow.locator('.vi-pol-use').isEnabled()).toBe(true);
      expect(await page.getByText('Lab notes').count()).toBe(0);
    });
    await step('it views the project’s own secret', async () => {
      await ownRow.locator('[data-vi-reveal]').click();
      await ownRow.locator('[data-vi-reveal-load]').click();
      await expect.poll(() => ownRow.locator('.vault-reveal-value pre').textContent()).toBe('shop-secret');
    });
    if (process.env.KARMAX_SCREENSHOT_DIR) await page.locator('.vault-manager-modal').screenshot({ path: `${process.env.KARMAX_SCREENSHOT_DIR}/project-vault-manager.png` });
    await step('and changes its policy', async () => {
      await ownRow.locator('.vi-pol-reveal').selectOption('never');
      await expect.poll(async () => (await vault.get(own.id))?.policy.reveal).toBe('never');
    });
    await page.locator('[data-vault-manager-close]').click();
    await step('a credential added by hand is the project’s', async () => {
      await card.locator('.vault-custom summary').click();
      await card.locator('.vi-type').selectOption('api-key');
      await card.locator('.vi-label').fill('Courier API');
      await card.locator('.vi-secret[data-field="secret"]').fill('courier-secret');
      await card.locator('.vi-add').click();
      await expect.poll(async () => (await vault.list()).find((item) => item.label === 'Courier API')?.ownerProjectId).toBe(shop.id);
      await card.locator('#vault-manage-open').getByText('3 items').waitFor();
    });
    expect(errors).toEqual([]);
  } finally { await context.close(); }
}, 90_000);
