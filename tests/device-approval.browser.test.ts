import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { launchChromium, openConsole, signIn } from './helpers/browser.js';
import { appGrantFixture, type AppGrantFixture } from './helpers/app-grants.js';

/** A person approves `tavya login` on the /device page, narrowing it to Viewer on one project. */
let f: AppGrantFixture;
let browser: Browser;
beforeAll(async () => { f = await appGrantFixture(); browser = await launchChromium(); });
afterAll(async () => { await browser?.close(); await f?.g.close(); });

const DEVICE = 'urn:ietf:params:oauth:grant-type:device_code';

it('approves a device code with a limit, after signing in on the page', async () => {
  const start = await f.form('/oauth/device', { client_id: 'tavya-cli', name: 'ada-laptop' });
  const console = await openConsole(browser, { ip: '192.0.2.71' });
  const { page } = console;
  try {
    // Opened signed out (from the link the CLI printed): sign in, land back on the code.
    await console.step('sign in from /device', async () => {
      await page.goto(start.body.verification_uri_complete);
      await page.locator('#email').fill(f.user.email);
      await page.locator('#pw').fill(f.password);
      await page.locator('#login-btn').click();
      await page.locator('#device-approve').waitFor();
    });
    await console.step('shows what is being approved', async () => {
      expect(await page.locator('#device-code').inputValue()).toBe(start.body.user_code);
      expect(await page.locator('.grant-who').innerText()).toContain('ada-laptop');
      expect(await page.locator('.grant-limit-value').innerText()).toBe('Your access');
    });
    await console.step('narrows access to Viewer on Site', async () => {
      await page.locator('.grant-limit summary').click();
      await page.locator('[data-grant-level]').selectOption('viewer');
      await page.locator('.grant-limit-projects label', { hasText: 'Site' }).locator('input').check();
      await expect.poll(() => page.locator('.grant-limit-value').innerText()).toBe('Viewer · Site');
    });
    await console.step('approves', async () => {
      await page.locator('#device-approve').click();
      await page.getByRole('heading', { name: 'Signed in' }).waitFor();
    });
    const token = await f.form('/oauth/token', { grant_type: DEVICE, device_code: start.body.device_code, client_id: 'tavya-cli' });
    expect(token.status).toBe(200);
    expect(token.body.scope).toBe(`level:viewer project:${f.site.id}`);
    expect(console.errors).toEqual([]);
  } finally { await console.context.close(); }
});

it('types a code by hand, explains a wrong one, and lists the sign-in under Profile → Apps and tokens', async () => {
  const start = await f.form('/oauth/device', { client_id: 'tavya-cli', name: 'build-box' });
  const console = await openConsole(browser, { ip: '192.0.2.72' });
  const { page } = console;
  try {
    await signIn(console.context, f.g.url, f.user.email, f.password);
    await console.step('rejects a wrong code', async () => {
      await page.goto(`${f.g.url}/device`);
      await page.locator('#device-code').fill('bbbb-bbbb');
      await page.locator('#device-continue').click();
      await expect.poll(() => page.locator('#grant-msg').innerText()).toMatch(/not valid/);
    });
    await console.step('accepts the right one, typed without the dash', async () => {
      await page.locator('#device-code').fill(start.body.user_code.replace('-', '').toLowerCase());
      await page.locator('#device-code').press('Enter');
      await page.locator('#device-approve').click();
      await page.getByRole('heading', { name: 'Signed in' }).waitFor();
    });
    // The device collects its tokens; that is when the grant exists.
    expect((await f.form('/oauth/token', { grant_type: DEVICE, device_code: start.body.device_code, client_id: 'tavya-cli' })).status).toBe(200);
    await console.step('lists and revokes it in the profile', async () => {
      await page.goto(`${f.g.url}/profile`);
      const row = page.locator('.app-grant-row', { hasText: 'build-box' });
      await row.waitFor();
      expect(await row.innerText()).toContain('Your access');
      await row.locator('[data-revoke-grant]').click();
      await row.waitFor({ state: 'detached' });
    });
    await console.step('creates a personal token shown once', async () => {
      await page.locator('#app-token-open').click();
      await page.locator('.app-token-form input[name=name]').fill('CI deploys');
      await page.locator('.app-token-form [type=submit]').click();
      const value = await page.locator('.app-token-once input').inputValue();
      expect(value).toMatch(/^tvp_/);
      await page.locator('.app-grant-row', { hasText: 'CI deploys' }).waitFor();
      expect((await f.call('GET', '/api/user/me', { bearer: value })).status).toBe(200);
    });
    expect(console.errors).toEqual([]);
  } finally { await console.context.close(); }
});
