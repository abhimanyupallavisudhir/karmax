// The vault manager lets a person limit a saved browser session to one task
// at a time (for sites that sign other copies out), through the real console
// against a hosted gateway.
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { VaultItems } from '../src/autonomy/vault-items.js';
import { hostedGateway, launchChromium, openConsole, signIn, type HostedGateway } from './helpers/browser.js';

let browser: Browser, g: HostedGateway;
const PASSWORD = 'correct horse battery staple 42';

beforeAll(async () => {
  browser = await launchChromium();
  g = await hostedGateway();
}, 60_000);
afterAll(async () => { await g?.close(); await browser?.close(); });

it('limits a saved session to one task at a time from the vault manager', async () => {
  const { organization } = await g.owner({ name: 'Ada', email: 'ada@example.test', password: PASSWORD, organization: 'Sessions Inc' });
  const vault = new VaultItems(g.store, g.broker, g.directory, organization.id);
  const item = await vault.save({ type: 'session', label: 'notion.so (signed in)', domains: ['notion.so'],
    secrets: { session: JSON.stringify({ version: 1, capturedAt: 1, cookies: [], storage: [] }) } });
  const login = await vault.save({ type: 'login', label: 'Notion login', domains: ['notion.so'], secrets: { password: 'pw' } });
  const { page, errors, step, context } = await openConsole(browser, { ip: '192.0.2.41' });
  try {
    await signIn(context, g.url, 'ada@example.test', PASSWORD);
    await step('open Passwords & payments', () => page.goto(`${g.url}/${organization.slug}/settings#settings-payments`));
    await step('open the vault manager', async () => {
      await page.locator('#vault-manage-open').getByText('2 items').waitFor();
      await page.locator('#vault-manage-open').click();
    });
    const row = page.locator(`[data-vi="${item.id}"]`);
    const toggle = row.locator('.vi-exclusive');
    await step('a session offers the toggle, and only a session', async () => {
      await toggle.waitFor();
      expect(await page.locator(`[data-vi="${login.id}"] .vi-exclusive`).count()).toBe(0);
      expect(await row.locator('[data-vi-rotate]').count()).toBe(0);
      expect(await toggle.locator('xpath=..').getAttribute('title')).toMatch(/sign other copies out/);
    });
    await toggle.check();
    await step('it is saved', () => expect.poll(async () => (await vault.get(item.id))?.exclusive).toBe(true));
    if (process.env.KARMAX_SCREENSHOT_DIR) await row.screenshot({ path: `${process.env.KARMAX_SCREENSHOT_DIR}/session-one-task-at-a-time.png` });
    await toggle.uncheck();
    await step('and turned off again', () => expect.poll(async () => (await vault.get(item.id))?.exclusive).toBeUndefined());
    expect(errors).toEqual([]);
  } finally { await context.close(); }
}, 60_000);
