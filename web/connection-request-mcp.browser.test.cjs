const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const source = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const actions = source.slice(source.indexOf('function connectionRows('), source.indexOf('async function wireInstallationComposioCard('));
const callback = source.slice(source.indexOf('async function finishMcpCallback('), source.indexOf('function taskPaymentsHtml('));
const helpers = `
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const S = { user: { id: 'alice' }, projects: [] };
  const toast = message => { throw new Error(message); };
  window.requests = [];
`;
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext(); const errors = [];
    await context.route('https://tavya.example/**', route => route.fulfill({ contentType: 'text/html', body: '<div id="app"></div>' }));
    await context.route('https://auth.example/**', route => route.fulfill({ contentType: 'text/html', body: 'Fixture MCP authorization page' }));
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto('https://tavya.example/task');
    await page.addScriptTag({ content: `${helpers}
      window.refreshed = 0;
      async function api(url, options = {}) {
        requests.push({ url, ...options });
        if (url.startsWith('/api/connections/connect')) return { connection: { id: 'conn_mail', status: 'connecting' }, callback: 'mcp',
          url: 'https://auth.example/authorize?state=fixture-state&code_challenge=x' };
        throw new Error('Unexpected ' + url);
      }
      ${actions}
      document.getElementById('app').innerHTML = connectionRows([{ id: 'conn_mail', label: 'Example Gmail', status: 'requested', taskId: 'task', projectIds: [],
        why: 'Read the invoices', mcp: { url: 'https://mail.example/mcp', auth: 'oauth' } }], true);
      wireConnectionActions(document.getElementById('app'), 'org', async () => { window.refreshed++; });
    ` });
    const opened = page.waitForEvent('popup');
    await page.getByRole('button', { name: 'Connect for this task' }).click();
    const popup = await opened; await popup.waitForURL('https://auth.example/**');
    assert.equal(await popup.evaluate(() => window.opener), null);
    await page.getByText('Finish signing in in the new tab').waitFor();

    // The MCP server returns the popup to Tavya's callback page with the same session storage.
    await popup.goto('https://tavya.example/mcp-callback?state=fixture-state&code=fixture-code');
    popup.on('pageerror', error => errors.push(error.message));
    await popup.addScriptTag({ content: `${helpers}
      async function api(url, options = {}) {
        const body = JSON.parse(options.body);
        if (url !== '/api/connections/conn_mail/callback?organizationId=org' || body.state !== 'fixture-state' || body.code !== 'fixture-code') throw new Error('Wrong callback ' + url);
        return { status: 'active' };
      }
      const siteNameMarkup = () => 'Fixture';
      ${callback}
      window.done = finishMcpCallback();
    ` });
    await popup.evaluate(() => window.done).catch(() => {});
    await page.waitForFunction(() => window.refreshed === 1);
    assert.deepEqual(errors, []);
    console.log('Task MCP sign-in stores the pending callback, finishes through the connection callback, and refreshes the task');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
