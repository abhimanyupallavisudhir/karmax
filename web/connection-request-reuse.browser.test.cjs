const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const source = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const actions = source.slice(source.indexOf('function connectionRows('), source.indexOf('async function wireInstallationComposioCard('));
const styles = fs.readFileSync(`${__dirname}/styles.css`, 'utf8');
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 760, height: 220 } }); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(`<style>${styles}</style><div id="app" class="approval-requests" style="padding:16px"></div>`);
    await page.addScriptTag({ content: `
      const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      const S = { user: { id: 'alice' }, projects: [] };
      const toast = message => { throw new Error(message); };
      window.requests = []; window.refreshed = 0;
      async function api(url, options = {}) { requests.push({ url, body: JSON.parse(options.body) }); return { connection: { id: 'conn_req', status: 'active' } }; }
      ${actions}
      // Two Gmail sign-ins share the app's name; only their connection dates tell them apart.
      document.getElementById('app').innerHTML = connectionRows([{ id: 'conn_req', label: 'gmail', status: 'requested', taskId: 'task', projectIds: [],
        why: 'Read the invoices', reusable: [{ id: 'conn_new', label: 'gmail', createdAt: Date.UTC(2026, 8, 30, 12) }, { id: 'conn_old', label: 'gmail', createdAt: Date.UTC(2026, 8, 12, 12) }] }], true);
      wireConnectionActions(document.getElementById('app'), 'org', async () => { window.refreshed++; });
    ` });
    assert.equal(await page.getByRole('button', { name: /^Use / }).count(), 0);
    const allow = page.getByRole('button', { name: 'Allow', exact: true });
    assert.equal(await allow.count(), 1);
    const picker = page.getByRole('combobox', { name: 'Account' });
    assert.equal(await picker.inputValue(), 'conn_new');
    const labels = await picker.locator('option').allTextContents();
    assert.equal(new Set(labels).size, 2, `account names must differ: ${labels}`);
    if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
    await picker.selectOption('conn_old');
    await allow.click();
    await page.waitForFunction(() => window.refreshed === 1);
    assert.deepEqual(await page.evaluate(() => window.requests), [{ url: '/api/connections/connect?organizationId=org', body: { id: 'conn_req', useConnectionId: 'conn_old' } }]);
    assert.deepEqual(errors, []);
    console.log('A task request with several connected accounts of one app offers one Allow and grants the picked account');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
