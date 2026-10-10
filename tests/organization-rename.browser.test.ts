// Renaming an organization in Settings moves its URL to the new name, and every
// link to the old one (a bookmark, a project page, an emailed or billing return
// link) still opens it, rewritten to the new address — through the real console
// against a hosted gateway.
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { consoleRequest, hostedGateway, launchChromium, openConsole, signIn, type HostedGateway } from './helpers/browser.js';

let browser: Browser, g: HostedGateway;
const PASSWORD = 'correct horse battery staple 42';

beforeAll(async () => {
  browser = await launchChromium();
  g = await hostedGateway();
}, 60_000);
afterAll(async () => { await g?.close(); await browser?.close(); });

it('moves the organization to its new name\'s URL and keeps old links working', async () => {
  const { organization } = await g.owner({ name: 'Ada', email: 'ada@example.test', password: PASSWORD, organization: 'Acme' });
  expect(organization.slug).toBe('acme');
  const { page, errors, step, context } = await openConsole(browser, { ip: '192.0.2.42' });
  try {
    await signIn(context, g.url, 'ada@example.test', PASSWORD);
    await consoleRequest(context, g.url, 'POST', `/api/organizations/${organization.id}/projects`, { name: 'Website' });

    await step('rename it in Settings', async () => {
      await page.goto(`${g.url}/acme/settings#settings-advanced`);
      await page.locator('#organization-name').fill('Acme Labs');
      await page.locator('#rename-organization').click();
    });
    await step('the address follows the name, keeping the page', async () => {
      await page.waitForURL(`${g.url}/acme-labs/settings#settings-advanced`);
      await expect.poll(() => page.locator('#organization-name').inputValue()).toBe('Acme Labs');
    });
    if (process.env.KARMAX_SCREENSHOT_DIR)
      await page.screenshot({ path: `${process.env.KARMAX_SCREENSHOT_DIR}/organization-renamed.png` });

    await step('an old project link opens the project at its new address', async () => {
      await page.goto(`${g.url}/acme/website/settings?x=1#settings-git`);
      await page.waitForURL(`${g.url}/acme-labs/website/settings?x=1#settings-git`);
    });
    await step('the old organization home redirects too', async () => {
      await page.goto(`${g.url}/acme`);
      await page.waitForURL(new RegExp(`^${g.url}/acme-labs(\\?|$)`));
    });
    await step('links the console builds name the new address', async () => {
      await expect.poll(() => page.locator('#rail a[href$="/website"]').first().getAttribute('href')).toBe('/acme-labs/website');
    });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 90_000);
