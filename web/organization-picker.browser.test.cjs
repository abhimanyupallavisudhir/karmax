// Real keyboard events through the shipped picker and global shortcut dispatcher.
// Run: node web/organization-picker.browser.test.cjs
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://picker.test/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      const file = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
      if (!fs.existsSync(file)) return route.abort();
      let body = fs.readFileSync(file, 'utf8');
      if (pathname === '/app.js') body = body.replace(/^boot\(\)\.catch\(.*$/m, `
        S.organizations = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }];
        S.organizationId = 'a'; S.tab = 'tasks';
        window.selections = [];
        document.querySelector('#app').innerHTML = '<aside id="rail">'
          + organizationComboHtml('org-switcher', 'a', 'Organization')
          + '</aside><input id="task-search" aria-label="Search tasks">';
        wireOrganizationCombo($('#org-switcher'), () => S.organizationId, async id => {
          selections.push(id); S.organizationId = id;
        });
        bindKeys();
      `);
      return route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    await page.goto('http://picker.test/');
    const input = page.getByRole('combobox', { name: 'Organization', exact: true });
    const menu = page.locator('#org-switcher-options');
    const assertEscaped = async expectedName => {
      await page.keyboard.press('Escape');
      assert.equal(await menu.isHidden(), true);
      assert.equal(await input.inputValue(), expectedName);
      assert.equal(await input.getAttribute('aria-expanded'), 'false');
      assert.equal(await input.getAttribute('aria-activedescendant'), null);
      assert.equal(await input.evaluate(el => el.contains(document.activeElement)), false, 'Escape releases picker focus');
      await page.keyboard.press('/');
      await page.waitForFunction(() => document.activeElement?.id === 'task-search');
      assert.equal(await input.inputValue(), expectedName, 'shortcut must not type into the picker');
    };

    await input.click();
    await input.fill('Bet');
    await page.keyboard.press('ArrowDown');
    assert.ok(await input.getAttribute('aria-activedescendant'));
    await assertEscaped('Alpha');
    assert.deepEqual(await page.evaluate(() => selections), [], 'Escape does not switch organizations');

    // Enter closes the menu but retains editing focus; Escape must still exit it.
    await input.click();
    await input.fill('Beta');
    await page.keyboard.press('Enter');
    assert.equal(await menu.isHidden(), true);
    await assertEscaped('Beta');
    assert.deepEqual(await page.evaluate(() => selections), ['b']);

    // Reopening with the caret after Escape remains usable.
    await page.getByRole('button', { name: 'Show organization options' }).click();
    assert.equal(await menu.isVisible(), true);
    await assertEscaped('Beta');
    assert.deepEqual(errors, []);
    console.log('Organization picker Escape and shortcut regressions passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
