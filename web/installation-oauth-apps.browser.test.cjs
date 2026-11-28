const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const source = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const slice = (from, to) => source.slice(source.indexOf(from), source.indexOf(to));
const card = slice('const OAUTH_APP_NAMES', 'async function hydrateNativeConnections(');
const helpers = slice('function instRow(', 'function instSegmented(') + slice('function policyTip(', 'function clearTotpQrPreview(');
const styles = fs.readFileSync(`${__dirname}/styles.css`, 'utf8');
// Installation → Sign-in apps (wiki features/service-connections § Sign-in apps).
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 260 } }); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(`<style>${styles}</style><div class="card" id="installation-oauth-apps-card" style="margin:16px"></div>`);
    await page.addScriptTag({ content: `
      const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      const toasts = []; const toast = (message, error) => { if (error) throw new Error(message); toasts.push(message); };
      const paneError = (box, error) => { throw error; };
      window.requests = []; window.apps = [];
      async function api(url, options = {}) {
        requests.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined });
        if ((options.method || 'GET') === 'PUT') { const body = JSON.parse(options.body);
          window.apps = [{ server: decodeURIComponent(url.split('/').pop()), clientId: body.clientId, hasSecret: !!body.clientSecret }]; return window.apps[0]; }
        if (options.method === 'DELETE') { window.apps = []; return { apps: [] }; }
        return { apps: window.apps, redirectUri: 'https://tavya.example/mcp-callback' };
      }
      ${helpers}
      ${card}
      wireInstallationOAuthAppsCard();
    ` });
    const box = page.locator('#installation-oauth-apps-card');
    await page.getByRole('button', { name: 'Save' }).waitFor();
    // Google is the server people need: offered without typing it.
    assert.equal(await page.getByLabel('Sign-in server').inputValue(), 'accounts.google.com');
    assert.ok(await page.getByRole('button', { name: /Redirect URI: https:\/\/tavya\.example\/mcp-callback/ }).count());
    await page.getByLabel('Client ID').fill('gid.apps.googleusercontent.com');
    await page.getByLabel('Client secret').fill('g-secret');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('button', { name: 'Remove' }).waitFor();
    const put = (await page.evaluate(() => window.requests)).find((request) => request.method === 'PUT');
    assert.deepEqual(put, { url: '/api/settings/oauth-apps/accounts.google.com', method: 'PUT', body: { clientId: 'gid.apps.googleusercontent.com', clientSecret: 'g-secret' } });
    const text = await box.innerText();
    assert.match(text, /Google/); assert.match(text, /gid\.apps\.googleusercontent\.com/);
    assert.doesNotMatch(await box.innerHTML(), /g-secret/);
    // Once Google has an app, the add row no longer suggests it.
    assert.equal(await page.getByLabel('Sign-in server').inputValue(), '');
    if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
    await page.getByRole('button', { name: 'Remove' }).click();
    await page.waitForFunction(() => !document.querySelector('[data-oauth-app-remove]'));
    assert.deepEqual(errors, []);
    console.log('Installation → Sign-in apps registers Google’s app (secret write-only, redirect URI shown) and removes it');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
