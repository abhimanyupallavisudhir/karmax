const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const source = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const slice = (from, to) => source.slice(source.indexOf(from), source.indexOf(to));
const card = slice('// Verified links and store listings', 'function openNativePushDialog(');
const helpers = slice('function policyTip(', 'function clearTotpQrPreview(');
const styles = fs.readFileSync(`${__dirname}/styles.css`, 'utf8');
// Installation → Phone apps → Links and Store listings (wiki planned/native-apps-round-2 § contracts 6).
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 560 } }); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(`<style>${styles}</style><div class="card" id="app-links-card" style="margin:16px"></div>`);
    await page.addScriptTag({ content: `
      const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      const $ = (selector) => document.querySelector(selector);
      const siteName = () => 'tavya';
      const toasts = []; const toast = (message, error) => { if (error) throw new Error(message); toasts.push(message); };
      const paneError = (box, error) => { throw error; };
      window.requests = []; window.settings = { androidCertFingerprints: [] };
      async function api(url, options = {}) {
        requests.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined });
        if (options.method === 'PUT') { const body = JSON.parse(options.body);
          window.settings = { androidCertFingerprints: body.androidCertFingerprints.map((f) => f.toUpperCase()),
            ...(body.appleTeamId ? { appleTeamId: body.appleTeamId } : {}), ...(body.appStoreUrl ? { appStoreUrl: body.appStoreUrl } : {}),
            ...(body.playStoreUrl ? { playStoreUrl: body.playStoreUrl } : {}) }; return { settings: window.settings }; }
        return { settings: window.settings };
      }
      ${helpers}
      ${card}
      wireAppLinksCard();
    ` });
    const box = page.locator('#app-links-card');
    await box.locator('#app-links-row').waitFor();
    assert.match(await box.innerText(), /None yet/);
    await box.locator('#app-links-row [data-app-links-edit]').click();
    await page.locator('.app-links-fingerprints').fill('aa:bb\ncc:dd');
    await page.locator('.app-links-team').fill('ABCDE12345');
    await page.locator('.app-links-ios').fill('https://apps.apple.com/app/tavya/id1');
    if (process.env.SCREENSHOT_DIALOG) await page.screenshot({ path: process.env.SCREENSHOT_DIALOG });
    await page.getByRole('button', { name: 'Save' }).click();
    await page.waitForFunction(() => !document.querySelector('.modal-overlay'));
    const put = (await page.evaluate(() => window.requests)).find((request) => request.method === 'PUT');
    assert.deepEqual(put, { url: '/api/settings/app-links', method: 'PUT', body: { androidCertFingerprints: ['aa:bb', 'cc:dd'],
      appleTeamId: 'ABCDE12345', appStoreUrl: 'https://apps.apple.com/app/tavya/id1', playStoreUrl: null } });
    await box.locator('a', { hasText: 'App Store' }).waitFor();
    assert.equal(await box.locator('.chip.done').count(), 2);
    if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
    assert.deepEqual(errors, []);
    console.log('Installation → Phone apps: Links and Store listings save the fingerprints, Team ID and store URLs');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
