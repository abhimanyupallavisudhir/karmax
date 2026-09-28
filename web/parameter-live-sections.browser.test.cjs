// Real browser regression: the Parameters tab's async sections (Authorization +
// Vault credentials, Cards + Budget, Codex/Claude) must not flicker back to
// "Loading…" and refetch on every background refresh of an in-flight task, and
// edits made in them must survive those refreshes. APP_SOURCE can test the baseline.
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
    const authorization = { level: 'developer', scope: 'projects', projectIds: ['p1'], capabilities: ['use-credential:item:v1'] };
    const record = { id: 'fixture', projectId: 'p1', workflow: 'software-dev', params: { _authorization: authorization, paymentPolicy: { cardIds: ['c1'], budget: 500 } } };
    const view = { taskId: 'fixture', title: 'Live sections', workflow: 'software-dev', stage: 'do', status: 'active', editableParams: [], agents: {}, messages: [], actions: [] };
    const payments = { cardIds: ['c1'], budget: 500, spent: 100 };
    const counts = {};
    const puts = [];
    await page.route('**/*', async route => {
      const request = route.request();
      const p = new URL(request.url()).pathname;
      if (p.startsWith('/api/')) {
        counts[p] = (counts[p] || 0) + 1;
        let data = [];
        if (p === '/api/tasks/fixture') data = view;
        else if (p === '/api/tasks/fixture/payments') {
          if (request.method() === 'PUT') { const body = request.postDataJSON(); puts.push(body); Object.assign(payments, body); }
          data = { ...payments, cards: [{ id: 'c1', label: 'Main card', last4: '4242', status: 'active' }], canEdit: !['done', 'cancelled', 'failed'].includes(view.status), released: [] };
        } else if (p === '/api/cards') data = [{ id: 'c1', label: 'Main card', last4: '4242', status: 'active' }, { id: 'c2', label: 'Spare card', last4: '1111', status: 'active', currency: 'eur' }];
        else if (p === '/api/vault/items') data = [{ id: 'v1', label: 'GitHub', type: 'login' }, { id: 'v2', label: 'Stripe', type: 'api-key' }];
        else if (p === '/api/organizations/o1/credentials') data = { credentials: [{ key: 'ambient:claude', kind: 'ambient', provider: 'claude' }], task: { own: {}, enabled: ['ambient:claude'] } };
        else if (p === '/api/organizations/o1/accounts') data = { logins: [] };
        else if (p.endsWith('/attempts')) data = null;
        else if (p.endsWith('/sessions')) data = {};
        else if (p.includes('/defaults/')) data = { task: { inherited: {} } };
        else if (p.endsWith('/tasks')) data = [record];
        else if (p.includes('explanation-settings')) data = { effective: { enabled: false } };
        return route.fulfill({ json: data });
      }
      const file = path.join(root, p === '/' ? 'index.html' : p);
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.abort();
      let body = fs.readFileSync(p === '/app.js' && process.env.APP_SOURCE || file, 'utf8');
      if (p === '/app.js') body = body.replace(/^boot\(\)\.catch\(.*$/m, 'window.parameterTest = { S, openTask, refreshTask, renderTaskPage };');
      return route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    await page.goto('http://parameter.test/');
    await page.waitForFunction(() => window.parameterTest);
    await page.evaluate(async ({ record }) => {
      const { S, openTask } = window.parameterTest;
      document.querySelector('#app').innerHTML = '<main id="main" style="height:800px"></main>';
      S.tasks = [record]; S.projects = [{ id: 'p1', slug: 'project', name: 'Project', organizationId: 'o1', config: {} }];
      S.projectId = 'p1'; S.organizationId = 'o1'; S.organizations = [{ id: 'o1', slug: 'test' }];
      S.meta = { workflows: [] }; S.schema = [{ name: 'software-dev', params: [] }];
      await openTask('fixture', 'parameters');
    }, { record });
    const vaultCount = page.locator('#tp-vault-count');
    const budget = page.locator('#tp-payments .payment-budget');
    await page.waitForFunction(() => document.querySelector('#tp-vault-count')?.textContent === '1 selected'
      && !document.querySelector('#tp-payments .payment-budget').disabled
      && document.querySelector('#cred-editor-task .cred-list'));
    const hydrated = { ...counts };

    // Record every "Loading…" placeholder painted from here on, and pin the
    // hydrated nodes a flicker would replace.
    await page.evaluate(() => {
      window.flickers = [];
      const loading = (node) => node.nodeType === 1
        && (/Loading/.test(node.textContent) || node.matches?.('[placeholder="Loading…"]') || node.querySelector?.('[placeholder="Loading…"]'));
      new MutationObserver((records) => {
        for (const record of records) for (const node of record.addedNodes)
          if (loading(node)) window.flickers.push(node.id || node.className || node.nodeName);
      }).observe(document.querySelector('#main'), { childList: true, subtree: true });
      window.pinned = [...document.querySelectorAll('#tp-vault-count, #tp-payments .payment-budget, #cred-editor-task .cred-list')];
    });
    const stillPinned = () => page.evaluate(() => window.pinned.every(node => node.isConnected));

    for (let i = 0; i < 3; i++) await page.evaluate(() => window.parameterTest.refreshTask());
    assert.deepEqual(await page.evaluate(() => window.flickers), [], 'background refreshes must not repaint hydrated sections as Loading…');
    assert.equal(await stillPinned(), true, 'hydrated sections stay mounted across refreshes');
    for (const hydration of ['/api/cards', '/api/organizations/o1/credentials', '/api/organizations/o1/accounts'])
      assert.equal(counts[hydration], hydrated[hydration], `${hydration} is not refetched on every refresh`);

    // An unsaved budget edit, and its caret, survive refreshes.
    await budget.fill('7.5');
    await budget.evaluate(el => { window.budgetNode = el; });
    await page.evaluate(() => window.parameterTest.refreshTask());
    assert.equal(await budget.evaluate(el => el === window.budgetNode && document.activeElement === el && el.value === '7.5'), true);
    assert.equal(await page.locator('#tp-payments .payment-save').isDisabled(), false);
    // Cards in two currencies let the budget choose its own (AU-36).
    const currency = page.locator('#tp-payments .payment-currency');
    assert.deepEqual(await currency.evaluate(el => [el.hidden, el.value, [...el.options].map(o => o.value)]), [false, 'usd', ['usd', 'eur']]);
    await currency.selectOption('eur');

    // Spending recorded elsewhere still shows up on the next refresh.
    payments.spent = 250;
    await page.evaluate(() => window.parameterTest.refreshTask());
    await page.waitForFunction(() => document.querySelector('#tp-payments .payment-spent').textContent === '$2.50 spent');

    // Saving is not followed by a Loading… repaint either.
    await page.locator('#tp-payments .payment-save').click();
    await page.waitForFunction(() => document.querySelector('#tp-payments .payment-save').disabled);
    assert.deepEqual(puts, [{ cardIds: ['c1'], budget: 750, currency: 'eur' }]);
    assert.equal(await page.locator('#tp-payments .payment-spent').textContent(), `${new Intl.NumberFormat(undefined, { style: 'currency', currency: 'eur' }).format(2.5)} spent`);
    await page.evaluate(() => { window.parameterTest.S.tasks[0].params.paymentPolicy = { cardIds: ['c1'], budget: 750, currency: 'eur' }; });
    await page.evaluate(() => window.parameterTest.refreshTask());
    assert.deepEqual(await page.evaluate(() => window.flickers), []);
    assert.equal(await stillPinned(), true);

    // A vault picker opened before a refresh still applies to the visible controls.
    await page.locator('#tp-vault-open').click();
    await page.locator('.vault-grant-pick[value="v2"]').waitFor();
    await page.evaluate(() => window.parameterTest.refreshTask());
    await page.locator('.vault-grant-pick[value="v2"]').check();
    await page.locator('[data-vault-apply]').click();
    assert.equal(await vaultCount.textContent(), '2 selected');
    assert.equal(await page.locator('#tp-auth-save').isDisabled(), false);
    await page.evaluate(() => window.parameterTest.refreshTask());
    assert.equal(await vaultCount.textContent(), '2 selected', 'unsaved vault grants survive a refresh');
    assert.equal(await stillPinned(), true);
    assert.deepEqual(await page.evaluate(() => window.flickers), []);

    // With no local edit, a grant changed elsewhere is picked up.
    await page.evaluate(() => { const { S } = window.parameterTest; delete S.authorizationEdits.fixture; });
    await page.evaluate(() => window.parameterTest.renderTaskPage());
    await page.evaluate(() => { window.parameterTest.S.tasks[0].params._authorization = { ...window.parameterTest.S.tasks[0].params._authorization, capabilities: [] }; });
    await page.evaluate(() => window.parameterTest.refreshTask());
    await page.waitForFunction(() => document.querySelector('#tp-vault-count')?.textContent === '0 selected');

    // Finishing the task still freezes payments.
    view.stage = 'done'; view.status = 'done';
    await page.evaluate(() => window.parameterTest.refreshTask());
    await page.waitForFunction(() => document.querySelector('#tp-payments .payment-budget')?.disabled
      && document.querySelector('#tp-payments .payment-save').hidden);
    assert.equal(await page.locator('#tp-auth').count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS: in-flight Parameters sections stay mounted across refreshes; edits, spend, save, external grants and freezing still apply');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
