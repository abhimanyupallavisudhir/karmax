// Connecting secrets is risky, and the console says so where it matters: the
// Passwords card carries the standing warning (and points at Connected apps),
// and each credential approval warns about the access mode it grants.
// Run: node web/vault-risk-warning.browser.test.cjs [screenshot.png]
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const items = [
  { id: 'vi_login', type: 'login', label: 'Staging login', domains: ['staging.example.test'], policy: {} },
  { id: 'vi_passkey', type: 'passkey', label: 'Staging passkey', domains: ['staging.example.test'], policy: {} },
];
const task = { id: 'task_1', num: 7, title: 'Sign in', projectId: 'project_1' };
const requests = [
  { id: 'vreq_reveal', taskId: 'task_1', itemId: 'vi_login', mode: 'reveal', why: 'paste the key', status: 'pending', task },
  { id: 'vreq_use', taskId: 'task_1', itemId: 'vi_login', mode: 'use', why: 'sign in', status: 'pending', task },
  { id: 'vreq_passkey', taskId: 'task_1', itemId: 'vi_passkey', mode: 'use', why: 'sign in', status: 'pending', task },
  { id: 'vreq_reset', taskId: 'task_1', itemId: 'vi_login', mode: 'use', kind: 'reset', why: 'rejected', status: 'pending', task },
];

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('http://vrisk.test/**', (route) => {
      const { pathname } = new URL(route.request().url());
      const file = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
      if (!fs.existsSync(file)) return route.abort();
      let body = fs.readFileSync(file, 'utf8');
      if (pathname === '/app.js') body = body.replace(/^boot\(\)\.catch\(.*$/m, `
        S.organizationId = 'org_personal';
        S.projects = [{ id: 'project_1', name: 'App', organizationId: 'org_personal' }];
        document.querySelector('#app').innerHTML = '<main style="padding:16px;max-width:820px">' + passwordsCard()
          + '<div class="approval-list" id="requests">' + credentialRequestRows(${JSON.stringify(requests)}, ${JSON.stringify(items)}) + '</div></main>';
      `);
      return route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    await page.goto('http://vrisk.test/');
    await page.locator('#vault-card').waitFor();

    const warning = page.locator('#vault-card [role="note"]');
    assert.equal(await warning.count(), 1, 'the Passwords card carries one risk warning');
    const text = (await warning.innerText()).replace(/\s+/g, ' ');
    assert.match(text, /at your own risk/i);
    assert.match(text, /reveal.*agent sees.*model provider.*training data/i, 'reveal: leaves for the model provider and training data');
    assert.match(text, /use.*blind use.*prompt injection.*malicious server/i, 'use: still leakable by a misbehaving agent');
    assert.match(text, /prefer.*MCP or Composio/i);
    assert.equal(await warning.getByRole('link', { name: /MCP or Composio/ }).getAttribute('href'), '#settings-connections',
      'points at Connected apps');
    const box = await warning.boundingBox();
    const vault = await page.locator('#vault-manage-open').boundingBox();
    assert.ok(box.y < vault.y, 'the warning precedes the vault itself');

    const warn = (id) => page.locator(`[data-vreq="${id}"] .approval-request-warn`);
    assert.match(await warn('vreq_reveal').innerText(), /model provider.*training data/i, 'a reveal approval warns about exposure');
    assert.match(await warn('vreq_use').innerText(), /malicious/i, 'a blind-use approval warns it can still leak');
    assert.equal(await warn('vreq_passkey').count(), 0, 'a passkey cannot be typed into a malicious site');
    assert.equal(await warn('vreq_reset').count(), 0, 'a reset report grants nothing new');
    if (process.argv[2]) await page.screenshot({ path: process.argv[2], fullPage: true });
    assert.deepEqual(errors, []);
    console.log('vault risk warning: ok');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exit(1); });
