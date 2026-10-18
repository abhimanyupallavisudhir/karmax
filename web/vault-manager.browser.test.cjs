// The Passwords card's vault manager is a table you can select from, as the
// import and task credential pickers are: Select all ticks what the search and
// type filter show, and the head turns into the bulk bar — set either policy
// for every ticked credential, or delete them all. Failures are reported and
// stay ticked.
// Run: node web/vault-manager.browser.test.cjs [screenshot.png]
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

let items = [
  { id: 'vi_gh', type: 'login', label: 'GitHub', username: 'alice', domains: ['github.com'], fields: ['password'], policy: { use: 'auto', reveal: 'ask' } },
  { id: 'vi_oa', type: 'api-key', label: 'OpenAI', envVar: 'OPENAI_API_KEY', fields: ['secret'], policy: { use: 'auto', reveal: 'ask' } },
  { id: 'vi_aws', type: 'api-key', label: 'AWS', envVar: 'AWS_ACCESS_KEY_ID', fields: ['secret'], policy: { use: 'ask', reveal: 'auto' } },
  { id: 'vi_st', type: 'login', label: 'Stripe', username: 'ops@acme.test', fields: ['password'], policy: { use: 'auto', reveal: 'ask' } },
  { id: 'vi_env', type: 'env', label: 'Staging .env', fields: ['env'], policy: { use: 'auto', reveal: 'ask' } },
];

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => dialog.accept());
    const posts = [], deletes = [];
    let failDelete = null;
    await page.route('http://vmanager.test/**', (route) => {
      const request = route.request();
      const { pathname } = new URL(request.url());
      if (pathname === '/api/vault/items' && request.method() === 'POST') {
        const body = request.postDataJSON();
        posts.push(body);
        const item = items.find((candidate) => candidate.id === body.id);
        Object.assign(item, { policy: body.policy });
        return route.fulfill({ json: { item } });
      }
      if (pathname === '/api/vault/items') return route.fulfill({ json: items });
      const del = pathname.match(/^\/api\/vault\/items\/([^/]+)$/);
      if (del && request.method() === 'DELETE') {
        deletes.push(del[1]);
        if (del[1] === failDelete) return route.fulfill({ status: 409, json: { error: 'in use by a running task' } });
        items = items.filter((item) => item.id !== del[1]);
        return route.fulfill({ json: { ok: true } });
      }
      if (pathname.startsWith('/api/')) return route.fulfill({ json: [] });
      const file = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
      if (!fs.existsSync(file)) return route.abort();
      let body = fs.readFileSync(file, 'utf8');
      if (pathname === '/app.js') body = body.replace(/^boot\(\)\.catch\(.*$/m, `
        S.organizationId = 'org_personal';
        document.querySelector('#app').innerHTML = '<main style="padding:16px;max-width:900px">' + passwordsCard() + '</main>';
        wireVaultCards('org_personal'); bindKeys();`);
      return route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    await page.goto('http://vmanager.test/');
    await page.locator('#vault-manage-open:not([disabled])').click();
    const dialog = page.getByRole('dialog', { name: 'Vault credentials' });
    await dialog.waitFor();
    const shown = () => dialog.locator('[data-vi]:visible').evaluateAll((rows) => rows.map((row) => row.dataset.vi));
    const head = dialog.locator('.vm-headlabel');
    const bulk = dialog.locator('.vm-bulk');
    assert.equal(await dialog.locator('.vm-total').innerText(), '5');
    assert.equal(await bulk.isVisible(), false, 'no bulk bar before anything is ticked');
    assert.equal(await head.innerText(), 'Select all');

    // The type filter narrows the table, and Select all takes only what it shows.
    await dialog.locator('[data-vm-type="api-key"]').click();
    assert.deepEqual((await shown()).sort(), ['vi_aws', 'vi_oa']);
    assert.equal(await head.innerText(), 'Select 2 shown');
    await dialog.getByRole('checkbox', { name: 'Select all' }).check();
    assert.equal(await head.innerText(), '2 selected');
    assert.equal(await bulk.isVisible(), true, 'the head turns into the bulk bar');
    if (process.argv[2]) await page.screenshot({ path: process.argv[2] });

    // Bulk policy: one field changes, the other keeps each credential's own value.
    await bulk.locator('.vm-bulk-reveal').selectOption('never');
    await page.waitForFunction(() => document.querySelectorAll('.vault-manager-item').length === 5 && !document.querySelector('.vm-bulk-reveal:disabled'));
    assert.deepEqual(posts.map((post) => [post.id, post.policy]).sort(), [['vi_aws', { use: 'ask', reveal: 'never' }], ['vi_oa', { use: 'auto', reveal: 'never' }]]);
    assert.deepEqual(await dialog.locator('[data-vi="vi_oa"] .vi-pol-reveal, [data-vi="vi_aws"] .vi-pol-reveal').evaluateAll((s) => s.map((x) => x.value)), ['never', 'never'],
      'the rows show the new policy');
    assert.equal(await head.innerText(), '2 selected', 'the selection survives a policy change');

    // A selection spans filters; the search narrows Select all too.
    await dialog.locator('[data-vm-type=""]').click();
    await dialog.locator('.vault-search').fill('stripe');
    assert.deepEqual(await shown(), ['vi_st']);
    await dialog.getByRole('checkbox', { name: 'Select all' }).check();
    assert.equal(await head.innerText(), '3 selected');
    await dialog.locator('.vault-search').fill('');
    // Enter on a row's checkbox ticks it (Enter elsewhere opens the credential).
    await dialog.locator('[data-vi="vi_env"] .vault-manage-pick').focus();
    await page.keyboard.press('Enter');
    assert.equal(await head.innerText(), '4 selected');
    await page.keyboard.press('Enter');
    assert.equal(await head.innerText(), '3 selected');

    // Bulk delete; a failure is named and stays ticked.
    failDelete = 'vi_aws';
    await bulk.getByRole('button', { name: 'Delete' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.vault-manager-item').length === 3);
    assert.deepEqual(deletes.sort(), ['vi_aws', 'vi_oa', 'vi_st']);
    assert.deepEqual((await shown()).sort(), ['vi_aws', 'vi_env', 'vi_gh']);
    assert.match(await page.locator('.toast').last().innerText(), /Deleted 2 of 3\. AWS: in use by a running task/);
    assert.equal(await head.innerText(), '1 selected', 'what could not be deleted stays selected');
    assert.equal(await dialog.locator('[data-vi="vi_aws"] .vault-manage-pick').isChecked(), true);
    assert.equal(await dialog.locator('.vm-total').innerText(), '3');
    assert.match(await page.locator('#vault-manage-open').innerText(), /3 items/, 'the card counts what is left');
    await dialog.getByRole('button', { name: 'Clear selection' }).click();
    assert.equal(await bulk.isVisible(), false);

    assert.deepEqual(errors, []);
    console.log('vault manager: ok');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exit(1); });
