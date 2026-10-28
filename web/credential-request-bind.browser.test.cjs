// A credential request for an item that is not in the vault is bound through the
// ordinary searchable "Vault credentials" picker, not a dropdown of every item,
// and links to Passwords & payments so the missing credential can be added.
// Run: node web/credential-request-bind.browser.test.cjs [screenshot.png]
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const items = Array.from({ length: 40 }, (_, i) => ({ id: `vi_${i}`, type: 'login', label: `Service ${i}`, domains: [`s${i}.example`], policy: {} }))
  .concat([{ id: 'vi_staging', type: 'login', label: 'Staging login', username: 'agent@example.test', domains: ['staging.example.test'], policy: {} }]);
const request = { id: 'vreq_1', taskId: 'task_1', domain: 'staging.example.test', mode: 'use', why: 'sign in', status: 'pending',
  task: { id: 'task_1', num: 7, title: 'Sign in', projectId: 'project_1' } };

async function open(browser, { settings = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  const errors = [];
  const resolves = [];
  let itemLoads = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://vreq.test/**', (route) => {
    const req = route.request();
    const { pathname, searchParams } = new URL(req.url());
    if (pathname === '/api/vault/items') {
      itemLoads++;
      assert.equal(searchParams.get('organizationId'), 'org_personal');
      return route.fulfill({ json: items });
    }
    if (pathname === '/api/vault/requests/vreq_1/resolve') {
      resolves.push(JSON.parse(req.postData()));
      return route.fulfill({ json: { id: 'vreq_1', status: 'granted', resume: { resumed: true } } });
    }
    const file = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
    if (!fs.existsSync(file)) return route.abort();
    let body = fs.readFileSync(file, 'utf8');
    if (pathname === '/app.js') body = body.replace(/^boot\(\)\.catch\(.*$/m, `
      S.organizationId = 'org_personal';
      S.projects = [{ id: 'project_1', name: 'App', organizationId: 'org_personal' }];
      window.resolved = 0;
      const paint = () => {
        const list = document.querySelector('#requests');
        list.innerHTML = credentialRequestRows([${JSON.stringify(request)}], []);
        wireCredentialRequestActions(list, 'org_personal', () => { window.resolved++; });
      };
      window.repaint = paint;
      document.querySelector('#app').innerHTML = '<main style="padding:16px"><div class="approval-list" id="requests"></div>'
        + ${settings ? `'<div id="vault-card"><details class="vault-custom"><summary>Add one by hand</summary><input class="vi-label"><input class="vi-domains"></details></div>'` : "''"} + '</main>';
      paint();
    `);
    return route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await page.goto('http://vreq.test/');
  await page.locator('[data-vreq]').waitFor();
  return { page, errors, resolves, itemLoads: () => itemLoads };
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const { page, errors, resolves, itemLoads } = await open(browser);
    const row = page.locator('[data-vreq="vreq_1"]');
    assert.equal(await row.locator('select').count(), 0, 'no dropdown of every vault item');
    const add = row.getByRole('link', { name: 'Add to vault' });
    assert.match(await add.getAttribute('href'), /\/settings#settings-payments$/, 'links to Passwords & payments');
    const pick = row.getByRole('button', { name: /Vault credentials/ });
    assert.match(await pick.innerText(), /Choose…/);
    for (const action of ['once', 'task', 'always'])
      assert.equal(await row.locator(`[data-vreq-act="${action}"]`).isDisabled(), true, `${action} waits for a credential`);
    assert.equal(await row.locator('[data-vreq-act="deny"]').isDisabled(), false, 'deny needs no credential');

    await pick.click();
    const dialog = page.getByRole('dialog', { name: 'Vault credentials' });
    await dialog.waitFor();
    assert.equal(itemLoads(), 1, 'the picker loads the current vault when it opens');
    assert.equal(await dialog.locator('.vault-grant-head').isVisible(), false, 'single choice has no Select all');
    assert.equal(await dialog.locator('.vault-task-use').count(), 0, 'single choice has no policy overrides');
    await dialog.getByRole('searchbox').fill('staging');
    assert.equal(await dialog.locator('[data-vault-item]:visible').count(), 1, 'search narrows the list');
    await dialog.getByRole('radio', { name: /Staging login/ }).check();
    if (process.argv[2]) await page.screenshot({ path: process.argv[2].replace(/\.png$/, '-picker.png') });
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await dialog.waitFor({ state: 'detached' });

    assert.match(await pick.innerText(), /Staging login/, 'the button shows the chosen credential');
    assert.equal(await row.locator('[data-vreq-act="task"]').isDisabled(), false, 'grants enable once bound');
    await page.evaluate(() => window.repaint());
    assert.match(await row.getByRole('button', { name: /Vault credentials/ }).innerText(), /Staging login/, 'a re-render keeps the choice');
    if (process.argv[2]) await page.screenshot({ path: process.argv[2] });

    await row.locator('[data-vreq-act="task"]').click();
    await page.waitForFunction(() => window.resolved === 1);
    assert.deepEqual(resolves, [{ action: 'task', itemId: 'vi_staging' }], 'the grant binds the chosen item');
    assert.deepEqual(errors, []);
    await page.close();

    // Beside the vault, "Add to vault" opens its folded hand-entry form for the requested site.
    const settings = await open(browser, { settings: true });
    await settings.page.getByRole('link', { name: 'Add to vault' }).click();
    assert.equal(await settings.page.locator('#vault-card .vault-custom').evaluate((el) => el.open), true, 'the form opens');
    assert.equal(await settings.page.locator('.vi-domains').inputValue(), 'staging.example.test', 'with the site filled in');
    assert.equal(await settings.page.evaluate(() => document.activeElement?.className), 'vi-label', 'ready for its name');
    assert.equal(new URL(settings.page.url()).pathname, '/', 'without leaving the page');
    assert.deepEqual(settings.errors, []);
    await settings.page.close();
    console.log('credential request bind: ok');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exit(1); });
