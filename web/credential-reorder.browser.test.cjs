// Reordering credentials is staged behind an explicit "Unsaved changes" save
// button. The order used to be saved only on `drop`, which never fires when the
// pointer is released just outside the one-line chip strip: the chips moved,
// nothing was saved, and a reload restored the old order.
// Run: node web/credential-reorder.browser.test.cjs [screenshot.png]
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const creds = [
  { key: 'login:claude:a', label: 'claude:a', provider: 'claude', kind: 'login', account: 'a' },
  { key: 'login:claude:b', label: 'claude:b', provider: 'claude', kind: 'login', account: 'b' },
  { key: 'login:codex:c', label: 'codex:c', provider: 'codex', kind: 'login', account: 'c' },
];

async function open(browser, { local = false } = {}) {
  let policy = {};
  const posts = [];
  const page = await browser.newPage({ viewport: { width: 760, height: 200 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://cred.test/**', (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const base = '/api/organizations/org_personal';
    if (pathname === `${base}/credentials`) {
      const off = new Set(policy.off || []);
      const order = [...(policy.order || []), ...creds.map((c) => c.key)].filter((k, i, all) => all.indexOf(k) === i);
      return route.fulfill({ json: { credentials: creds, global: { own: policy, enabled: order.filter((k) => !off.has(k)) } } });
    }
    if (pathname === `${base}/accounts`) return route.fulfill({ json: { logins: [] } });
    if (pathname === `${base}/credentials/policy`) {
      const body = JSON.parse(request.postData());
      posts.push(body.policy);
      policy = body.policy;
      return route.fulfill({ json: { ok: true } });
    }
    const file = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
    if (!fs.existsSync(file)) return route.abort();
    let body = fs.readFileSync(file, 'utf8');
    if (pathname === '/app.js') body = body.replace(/^boot\(\)\.catch\(.*$/m, `
      S.organizationId = 'org_personal';
      window.localChanges = [];
      document.querySelector('#app').innerHTML = '<main style="padding:16px"><div class="section-h">Credentials</div>'
        + '<div id="cred-editor"></div></main>';
      renderCredentialEditor($('#cred-editor'), ${JSON.stringify(local ? 'task' : 'global')}, { organizationId: 'org_personal'${local
        ? ", local: true, onChange: (p) => window.localChanges.push(p)" : ''} });
    `);
    return route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await page.goto('http://cred.test/');
  await page.locator('.cred-row').first().waitFor();
  const order = () => page.locator('.cred-row').evaluateAll((rows) => rows.map((row) => row.dataset.key));
  // Drag `key` in front of `beforeKey`, then release the pointer BELOW the chip
  // strip — where no `drop` event fires.
  const dragOutside = async (key, beforeKey) => {
    const handle = await page.locator(`.cred-row[data-key="${key}"] .cred-drag`).boundingBox();
    const target = await page.locator(`.cred-row[data-key="${beforeKey}"]`).boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + 6, handle.y + handle.height / 2); // starts the drag
    await page.waitForFunction(() => document.querySelector(".cred-row.dragging"));
    await page.mouse.move(target.x + 3, target.y + target.height / 2); // dragenter
    await page.mouse.move(target.x + 4, target.y + target.height / 2); // dragover
    await page.mouse.move(target.x + 4, target.y + target.height + 60);
    await page.mouse.up();
  };
  return { page, posts, errors, order, dragOutside };
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const { page, posts, errors, order, dragOutside } = await open(browser);
    const saveButton = page.getByRole('button', { name: /Unsaved changes/ });
    assert.equal(await saveButton.isVisible(), false, 'nothing to save before a reorder');

    await dragOutside('login:codex:c', 'login:claude:a');
    assert.deepEqual(await order(), ['login:codex:c', 'login:claude:a', 'login:claude:b']);
    await saveButton.waitFor();
    assert.deepEqual(posts, [], 'a reorder is staged, not saved');
    if (process.argv[2]) await page.screenshot({ path: process.argv[2] });

    await saveButton.click();
    await page.waitForFunction(() => !document.querySelector('.cred-save:not([hidden])'));
    assert.deepEqual(posts, [{ order: ['login:codex:c', 'login:claude:a', 'login:claude:b'] }]);
    assert.deepEqual(await order(), ['login:codex:c', 'login:claude:a', 'login:claude:b'], 'the saved order survives the reload');

    // Dragging back to the saved order leaves nothing to save.
    await dragOutside('login:claude:b', 'login:claude:a');
    await saveButton.waitFor();
    await dragOutside('login:claude:a', 'login:claude:b');
    assert.deepEqual(await order(), ['login:codex:c', 'login:claude:a', 'login:claude:b']);
    assert.equal(await saveButton.isVisible(), false);

    // Toggling a credential saves what is on screen, including a staged order.
    await dragOutside('login:claude:b', 'login:codex:c');
    await saveButton.waitFor();
    await page.locator('.cred-row[data-key="login:claude:a"] .cred-toggle').click();
    await page.waitForFunction(() => document.querySelector('.cred-row[data-key="login:claude:a"]')?.classList.contains('off'));
    assert.deepEqual(posts.at(-1).order, ['login:claude:b', 'login:codex:c', 'login:claude:a']);
    assert.deepEqual(posts.at(-1).off, ['login:claude:a']);
    assert.equal(await saveButton.isVisible(), false);
    assert.deepEqual(errors, []);
    await page.close();

    // The New Task form is itself a draft: a reorder there applies at once.
    const local = await open(browser, { local: true });
    await local.dragOutside('login:codex:c', 'login:claude:a');
    await local.page.waitForFunction(() => window.localChanges.length === 1);
    assert.deepEqual(await local.page.evaluate(() => window.localChanges[0].order), ['login:codex:c', 'login:claude:a', 'login:claude:b']);
    assert.equal(await local.page.getByRole('button', { name: /Unsaved changes/ }).isVisible(), false);
    assert.deepEqual(local.errors, []);
  } finally {
    await browser.close();
  }
  console.log('ok  a credential reorder is staged behind an Unsaved-changes save button, even when released off the strip');
})().catch((error) => { console.error(error); process.exit(1); });
