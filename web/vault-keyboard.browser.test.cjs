// The vault credential pop-ups are driven from the keyboard like the other
// pickers: focus stays in the search box, ↑/↓ move a highlighted row (kept in
// view), Enter acts on it, Esc closes. Keys the dialog handles never reach the
// page's own shortcuts below it.
// Run: node web/vault-keyboard.browser.test.cjs [screenshot.png]
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const items = Array.from({ length: 30 }, (_, i) => ({ id: `vi_${i}`, type: 'login', label: `Service ${String(i).padStart(2, '0')}`, domains: [`s${i}.example`], fields: ['password'], policy: {} }))
  .concat([{ id: 'vi_staging', type: 'login', label: 'Staging login', username: 'agent@example.test', domains: ['staging.example.test'], fields: ['password'], policy: {} }]);

async function open(browser) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://vkeys.test/**', (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/api/vault/items') return route.fulfill({ json: items });
    if (pathname.startsWith('/api/')) return route.fulfill({ json: [] });
    const file = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
    if (!fs.existsSync(file)) return route.abort();
    let body = fs.readFileSync(file, 'utf8');
    if (pathname === '/app.js') body = body.replace(/^boot\(\)\.catch\(.*$/m, `
      S.organizationId = 'org_personal';
      S.projects = [{ id: 'project_1', name: 'App', organizationId: 'org_personal' }];
      document.querySelector('#app').innerHTML = '<main style="padding:16px;max-width:820px"><button id="opener">Vault credentials</button>' + passwordsCard() + '</main>';
      wireVaultCards('org_personal');
      // The page's own shortcuts ('n' opens a new task) stay quiet under the dialog,
      // and the keys the dialog handles (list cursor, Esc closes the page) never arrive.
      bindKeys();
      window.shortcuts = [];
      openNewTaskForm = () => window.shortcuts.push('n');
      window.leaked = [];
      document.addEventListener('keydown', (e) => { if (['ArrowUp', 'ArrowDown', 'Enter', 'Escape'].includes(e.key)) window.leaked.push(e.key); });
      window.applied = [];
      window.openPicker = (selected, single) => openVaultGrantPicker(${JSON.stringify(items)}, new Set(selected), {},
        (ids) => window.applied.push([...ids]), { single });
    `);
    return route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await page.goto('http://vkeys.test/');
  await page.locator('#vault-manage-open:not([disabled])').waitFor();
  return { page, errors };
}

const active = (dialog) => dialog.locator('.active[data-vault-item], .active[data-vi]');
const activeId = async (dialog) => {
  assert.equal(await active(dialog).count(), 1, 'exactly one highlighted row');
  return active(dialog).evaluate((row) => row.dataset.vaultItem || row.dataset.vi);
};
const inView = (dialog) => active(dialog).evaluate((row) => {
  const list = row.closest('.vault-grant-tree, .vault-manager-list');
  const a = row.getBoundingClientRect(); const b = list.getBoundingClientRect();
  return a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
});
const focused = (page) => page.evaluate(() => document.activeElement?.className || document.activeElement?.tagName);

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const { page, errors } = await open(browser);
    const dialog = page.getByRole('dialog', { name: 'Vault credentials' });
    const pick = (id) => dialog.locator(`[data-vault-item="${id}"] .vault-grant-pick`);

    // ── multi-select picker ──
    await page.locator('#opener').focus();
    await page.evaluate(() => window.openPicker(['vi_3'], false));
    await dialog.waitFor();
    assert.equal(await focused(page), 'vault-search', 'opens in the search box');
    assert.equal(await activeId(dialog), 'vi_3', 'the first row (selected items sort first) is highlighted');
    await page.keyboard.press('ArrowUp');
    assert.equal(await activeId(dialog), 'vi_3', '↑ stops at the top');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    assert.equal(await activeId(dialog), 'vi_1', '↓ moves down the list');
    await page.keyboard.press('ArrowUp');
    assert.equal(await activeId(dialog), 'vi_0', '↑ moves up');
    assert.equal(await focused(page), 'vault-search', 'focus stays in the search box');
    for (let i = 0; i < 40; i++) await page.keyboard.press('ArrowDown');
    assert.equal(await activeId(dialog), 'vi_staging', '↓ stops at the bottom');
    assert.ok(await inView(dialog), 'the highlighted row is scrolled into view');

    await page.keyboard.type('stag');
    assert.equal(await activeId(dialog), 'vi_staging', 'typing highlights the first match');
    await page.keyboard.press('Enter');
    assert.equal(await pick('vi_staging').isChecked(), true, 'Enter ticks the highlighted credential');
    assert.equal(await dialog.locator('[data-vault-item="vi_staging"] .vault-task-use').isDisabled(), false, 'its policy overrides unlock');
    assert.match(await dialog.locator('.vault-grant-selected').innerText(), /2 selected/);
    await page.keyboard.press('Enter');
    assert.equal(await pick('vi_staging').isChecked(), false, 'Enter again unticks it');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    assert.equal(await activeId(dialog), 'vi_staging', 'clearing the search keeps the highlighted row when still shown');

    // A focused checkbox moves like the search does, carrying focus.
    await pick('vi_5').focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await activeId(dialog), 'vi_6', 'arrows from a checkbox move the highlight');
    assert.equal(await page.evaluate(() => document.activeElement.value), 'vi_6', 'and move focus to the next checkbox');
    await page.keyboard.press('Enter');
    assert.equal(await pick('vi_6').isChecked(), true, 'Enter on a checkbox ticks it');
    assert.deepEqual(await page.evaluate(() => window.leaked), [], 'handled keys stay in the dialog');
    // A policy dropdown keeps its own arrows.
    await dialog.locator('[data-vault-item="vi_6"] .vault-task-use').focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await activeId(dialog), 'vi_6', 'arrows in a dropdown do not move the highlight');
    await page.evaluate(() => { window.leaked = []; });
    await dialog.getByRole('button', { name: 'Cancel' }).focus();
    await page.keyboard.press('n');
    assert.deepEqual(await page.evaluate(() => window.shortcuts), [], 'page shortcuts are off while the dialog is open');
    await page.keyboard.press('ArrowUp');
    assert.equal(await activeId(dialog), 'vi_5', 'arrows from a dialog button move the highlight');
    assert.equal(await focused(page), 'vault-search', 'and return to the search box');

    if (process.argv[2]) await page.screenshot({ path: process.argv[2].replace(/\.png$/, '-picker.png') });
    assert.match(await dialog.getByRole('button', { name: 'Apply' }).getAttribute('title'), /Ctrl\+↵|⌘↵/, 'Apply names its shortcut');
    await dialog.locator('.vault-search').focus();
    await page.keyboard.press('Control+Enter');
    await dialog.waitFor({ state: 'detached' });
    assert.deepEqual(await page.evaluate(() => window.applied.pop()?.sort()), ['vi_3', 'vi_6', 'vi_staging'], 'Ctrl+Enter applies');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'opener', 'focus returns to the opener');

    await page.evaluate(() => window.openPicker([], false));
    await dialog.waitFor();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    assert.deepEqual(await page.evaluate(() => window.applied), [], 'Esc closes without applying');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'opener');

    // ── single choice (binding a credential request) ──
    await page.evaluate(() => window.openPicker(['vi_4'], true));
    await dialog.waitFor();
    assert.equal(await activeId(dialog), 'vi_4', 'the current choice is highlighted');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await dialog.waitFor({ state: 'detached' });
    assert.deepEqual(await page.evaluate(() => window.applied.pop()), ['vi_0'], 'Enter chooses the highlighted credential');
    await page.evaluate(() => window.openPicker([], true));
    await dialog.waitFor();
    await page.keyboard.type('nothing matches');
    assert.equal(await active(dialog).count(), 0, 'no highlight without a match');
    await page.keyboard.press('Enter');
    assert.equal(await dialog.isVisible(), true, 'Enter without a match does nothing');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });

    // ── the Passwords card's vault manager ──
    const opener = page.locator('#vault-manage-open');
    await opener.click();
    await dialog.waitFor();
    assert.equal(await focused(page), 'vault-search');
    const firstId = await activeId(dialog);
    await page.keyboard.press('ArrowDown');
    const secondId = await activeId(dialog);
    assert.notEqual(secondId, firstId, '↓ moves down the vault');
    await page.keyboard.type('staging');
    assert.equal(await activeId(dialog), 'vi_staging');
    await page.keyboard.press('Enter');
    const panel = dialog.locator('[data-vi="vi_staging"] .vault-reveal-panel');
    assert.equal(await panel.isVisible(), true, 'Enter opens the highlighted credential');
    assert.equal(await page.evaluate(() => document.activeElement.hasAttribute('data-vi-reveal-load')), true, 'focus lands on Reveal');
    if (process.argv[2]) await page.screenshot({ path: process.argv[2] });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement.id), 'vault-manage-open', 'focus returns to the opener');
    assert.deepEqual(await page.evaluate(() => window.leaked), [], 'handled keys stay in the dialog');
    assert.deepEqual(errors, []);
    console.log('vault keyboard: ok');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exit(1); });
