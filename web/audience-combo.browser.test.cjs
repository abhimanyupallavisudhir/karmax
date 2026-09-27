// Real browser regression: "Who confirms" / "Who responds" take a comma-separated
// list, so suggestions must follow the entry under the cursor, not the whole value.
// APP_SOURCE can test the baseline.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = __dirname;
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const record = { id: 'fixture', projectId: 'p1', workflow: 'software-dev', params: {} };
    const view = { taskId: 'fixture', title: 'Audience', workflow: 'software-dev', stage: 'do', status: 'active', editableParams: ['confirmer', 'responder'], agents: {}, messages: [], actions: [] };
    await page.route('**/*', async route => {
      const p = new URL(route.request().url()).pathname;
      if (p.startsWith('/api/')) {
        let data = [];
        if (p === '/api/tasks/fixture') data = view;
        else if (p.endsWith('/attempts')) data = null;
        else if (p.endsWith('/sessions')) data = {};
        else if (p.includes('/defaults/')) data = { task: { inherited: {} } };
        else if (p.endsWith('/tasks')) data = [record];
        else if (p.includes('explanation-settings')) data = { effective: { enabled: false } };
        return route.fulfill({ json: data });
      }
      let file = path.join(root, p === '/' ? 'index.html' : p);
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.abort();
      let body = fs.readFileSync(p === '/app.js' && process.env.APP_SOURCE || file, 'utf8');
      if (p === '/app.js') body = body.replace(/^boot\(\)\.catch\(.*$/m, 'window.audienceTest = { S, openTask, resetConfirmerField };');
      return route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    await page.goto('http://audience.test/');
    await page.waitForFunction(() => window.audienceTest);
    await page.evaluate(async ({ record }) => {
      const { S, openTask } = window.audienceTest;
      document.querySelector('#app').innerHTML = '<main id="main" style="height:800px"></main>';
      S.tasks = [record]; S.projects = [{ id: 'p1', slug: 'project', name: 'Project', organizationId: 'o1', config: {} }];
      S.projectId = 'p1'; S.organizationId = 'o1'; S.organizations = [{ id: 'o1', slug: 'test' }];
      S.users = [{ id: 'u_alice', name: 'Alice Doe' }, { id: 'u_bob', name: 'Bob Roe' }];
      S.organizationMembers = [{ userId: 'u_alice' }, { userId: 'u_bob' }];
      S.teams = [{ id: 't1', slug: 'leaders', name: 'Leaders' }];
      S.meta = { workflows: [] };
      S.schema = [{ name: 'software-dev', params: [
        { name: 'confirmer', label: 'Review', type: 'confirmer', scopes: ['task'], promptDefault: 'Review carefully' },
        { name: 'responder', label: 'Input', type: 'responder', scopes: ['task'], promptDefault: 'Answer' },
      ] }];
      await openTask('fixture', 'parameters');
    }, { record });

    const suggestions = (input) => input.evaluate(el => [...el.closest('.combo').querySelectorAll('.combo-menu:not([hidden]) .combo-opt')].map(o => o.dataset.v));
    for (const selector of ['.confirmer-field .cf-audience', '.responder-field .rf-audience']) {
      const input = page.locator(selector);
      await input.waitFor({ state: 'visible' });
      assert.equal(await input.inputValue(), '@creator');
      // After a comma, only the entry being typed is matched.
      await input.click(); await input.press('End');
      await page.keyboard.type(', ali');
      assert.deepEqual(await suggestions(input), ['user:u_alice'], `${selector}: suggestions for the second entry`);
      await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
      assert.equal(await input.inputValue(), '@creator, user:u_alice, ', `${selector}: choosing replaces only the current entry`);
      // Chosen entries are not suggested again.
      await page.keyboard.type('@');
      const next = await suggestions(input);
      assert.ok(next.includes('@team:leaders') && !next.includes('@creator') && !next.includes('user:u_alice'), `${selector}: ${next}`);
      // Editing a middle entry replaces just that entry and keeps the rest.
      await input.fill('@creator, lead, user:u_bob');
      await input.evaluate(el => { el.focus(); el.setSelectionRange(14, 14); el.dispatchEvent(new Event('input', { bubbles: true })); });
      assert.deepEqual(await suggestions(input), ['@team:leaders'], `${selector}: middle entry`);
      await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
      assert.equal(await input.inputValue(), '@creator, @team:leaders, user:u_bob', `${selector}: middle replacement`);
      assert.equal(await input.evaluate(el => el.selectionStart), '@creator, @team:leaders'.length);
      await input.blur();
    }

    // Rows rebuilt by a reset, or added after removing every step, get the same suggestions.
    const rebuilt = async (label) => {
      const input = page.locator('.confirmer-field .cf-audience');
      assert.equal(await input.inputValue(), '@creator', label);
      await input.click(); await input.press('End');
      await page.keyboard.type(', bob');
      assert.deepEqual(await suggestions(input), ['user:u_bob'], label);
      await input.blur();
    };
    await page.evaluate(() => window.audienceTest.resetConfirmerField(document.querySelector('.confirmer-field')));
    await rebuilt('after reset');
    await page.locator('.confirmer-field .cf-del').click();
    await page.locator('.confirmer-field .cf-add').click();
    await rebuilt('after adding a step');
    assert.deepEqual(errors, []);
    console.log('PASS: Who confirms / Who responds suggest and complete every comma-separated entry');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
