// Real browser regression: shipped task opening, background refresh, editing and
// saving against a deterministic API fixture. APP_SOURCE can test the baseline.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = __dirname;
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const prompt = Array.from({ length: 40 }, (_, i) => `Review instruction ${i}`).join('\n');
    const record = { id: 'fixture', projectId: 'p1', workflow: 'software-dev', params: { confirmer: { layers: [{ kind: 'agent', provider: 'mock', prompt }] } } };
    const view = { taskId: 'fixture', title: 'Parameter editing', workflow: 'software-dev', stage: 'do', status: 'active', editableParams: ['confirmer'], agents: {}, messages: [], actions: [] };
    const patches = [];
    let failSave = false;
    await page.route('**/*', async route => {
      const p = new URL(route.request().url()).pathname;
      if (p.startsWith('/api/')) {
        let data = [];
        if (p === '/api/tasks/fixture/params') {
          if (failSave) return route.fulfill({ status: 500, json: { error: 'Save failed' } });
          const patch = route.request().postDataJSON().params;
          patches.push(patch); Object.assign(record.params, patch); data = { view };
        } else if (p === '/api/tasks/fixture') data = view;
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
      if (p === '/app.js') body = body.replace(/^boot\(\)\.catch\(.*$/m, 'window.parameterTest = { S, openTask, refreshTask, renderTaskPage, setTaskTab };');
      return route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    await page.goto('http://parameter.test/');
    await page.waitForFunction(() => window.parameterTest);
    await page.evaluate(async ({ record }) => {
      const { S, openTask } = window.parameterTest;
      document.querySelector('#app').innerHTML = '<main id="main" style="height:600px"></main>';
      S.tasks = [record]; S.projects = [{ id: 'p1', slug: 'project', name: 'Project', organizationId: 'o1', config: {} }];
      S.projectId = 'p1'; S.organizationId = 'o1'; S.organizations = [{ id: 'o1', slug: 'test' }];
      S.meta = { workflows: [] };
      S.schema = [{ name: 'software-dev', params: [{ name: 'confirmer', label: 'Review', type: 'confirmer', scopes: ['task'], legacyPrompt: 'Review carefully' }] }];
      await openTask('fixture', 'parameters');
    }, { record });
    const textarea = page.locator('.ab-instructions');
    await textarea.waitFor({ state: 'visible' });
    await page.evaluate(() => window.parameterTest.refreshTask());
    // Even a pristine focused control must remain connected on refresh.
    await textarea.evaluate(el => { window.pristineNode = el; el.focus(); });
    await page.evaluate(() => window.parameterTest.refreshTask());
    assert.equal(await textarea.evaluate(el => el === window.pristineNode && document.activeElement === el), true);
    await textarea.fill(prompt + '\nUnsaved review');
    await textarea.evaluate(el => {
      window.editingNode = el;
      el.style.height = '230px'; el.focus(); el.setSelectionRange(21, 31, 'backward'); el.scrollTop = 170;
      document.querySelector('#tp-body').scrollTop = 100;
      window.editingState = { top: el.scrollTop, body: document.querySelector('#tp-body').scrollTop };
    });
    assert.equal(await page.evaluate(() => window.editingState.top > 0 && window.editingState.body > 0), true, 'fixture must exercise both scrollers');
    for (let i = 0; i < 5; i++) await page.evaluate(() => window.parameterTest.refreshTask());
    assert.deepEqual(await textarea.evaluate(el => ({ same: el === window.editingNode, focused: document.activeElement === el,
      start: el.selectionStart, end: el.selectionEnd, direction: el.selectionDirection, height: el.style.height,
      scroll: el.scrollTop === window.editingState.top, body: document.querySelector('#tp-body').scrollTop === window.editingState.body })),
      { same: true, focused: true, start: 21, end: 31, direction: 'backward', height: '230px', scroll: true, body: true });
    await page.keyboard.insertText('Edited');
    const edited = await textarea.inputValue();
    failSave = true;
    await page.locator('#params-save').click();
    await page.waitForFunction(() => document.querySelector('#tp-params').dataset.saveState === 'dirty');
    assert.equal(await textarea.inputValue(), edited);
    failSave = false;
    await page.locator('#params-save').click();
    await page.waitForFunction(() => document.querySelector('#tp-params').dataset.saveState === 'saved');
    assert.equal(patches.length, 1, 'retained controls must not acquire duplicate save handlers');
    assert.equal(patches[0].confirmer.layers[0].prompt, edited);
    await page.evaluate(() => window.parameterTest.refreshTask());
    assert.equal(await textarea.evaluate(el => el === window.editingNode), true, 'save refresh retains the textarea');
    await page.evaluate(async () => { const t = window.parameterTest; t.setTaskTab('overview'); await t.openTask('fixture', 'parameters'); });
    assert.equal(await textarea.inputValue(), edited, 'saved prompt survives reopening');
    // A clean editor must still reflect an external update.
    await page.evaluate(() => { window.parameterTest.S.tasks[0].params.confirmer.layers[0].prompt = 'Updated elsewhere'; });
    await page.evaluate(() => window.parameterTest.refreshTask());
    assert.equal(await textarea.inputValue(), 'Updated elsewhere');
    // Transient empty input must not be replaced by the built-in prompt.
    await textarea.fill('');
    await page.evaluate(() => window.parameterTest.refreshTask());
    assert.equal(await textarea.inputValue(), '');
    view.stage = 'done'; view.editableParams = [];
    await page.evaluate(() => window.parameterTest.refreshTask());
    assert.equal(await page.locator('#params-save').count(), 0, 'terminal transition freezes controls');
    // The route stays visible, read-only, in the task form's shape.
    assert.equal(await textarea.isDisabled(), true);
    assert.deepEqual(errors, []);
    console.log('PASS: live refresh preserves textarea, focus, selection, resize and scroll; failed save, retry, persistence, and lifecycle locking');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
