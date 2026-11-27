const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const source = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const actions = source.slice(source.indexOf('function connectionRows('), source.indexOf('async function wireInstallationComposioCard('));
const styles = fs.readFileSync(`${__dirname}/styles.css`, 'utf8');
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 760, height: 200 } }); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(`<style>${styles}</style><div id="app" class="approval-requests" style="padding:16px"></div>`);
    await page.addScriptTag({ content: `
      const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      const S = { user: { id: 'alice' }, projects: [] };
      const toast = message => { throw new Error(message); };
      window.requests = [];
      window.open = () => ({ location: {}, close() {} });
      async function api(url, options = {}) { requests.push({ url, body: JSON.parse(options.body) }); return { connection: { id: 'conn_again', status: 'connecting' }, url: 'https://connect.composio.dev/link/x' }; }
      ${actions}
      // A task asks Alice to sign her Gmail in again; outside the task (Settings) she still sees why.
      document.getElementById('app').innerHTML = connectionRows([{ id: 'conn_again', label: 'gmail', status: 'requested', taskId: 'task', ownerId: 'alice',
        reconnects: 'conn_account', projectIds: [], why: 'Creating filters needs “Manage your basic mail settings and filters”' }], false);
      wireConnectionActions(document.getElementById('app'), 'org', async () => {});
    ` });
    const text = await page.locator('#app').innerText();
    assert.match(text, /sign in again/);
    assert.match(text, /Manage your basic mail settings/);
    // A sign-in again is never answered with an existing account.
    assert.equal(await page.getByRole('button', { name: 'Allow', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Decline', exact: true }).count(), 1);
    assert.doesNotMatch(text, /Project access/);
    if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
    await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await page.getByRole('link', { name: /Sign in with Composio/ }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.requests), [{ url: '/api/connections/connect?organizationId=org', body: { id: 'conn_again', restart: false } }]);
    assert.deepEqual(errors, []);
    console.log('A task’s request to sign an account in again shows why, offers Reconnect and no Allow, and starts a fresh sign-in');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
