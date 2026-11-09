// A permanent co-ordinator in the full console shell (wiki features/coordinator),
// with trusted Chromium input: the task form's last row, after Avatār — ticking
// it reveals its check-in interval, pre-filled with 24 hours, which takes
// decimals; the task is created with it; and its row in the list says so.
// Run: node web/coordinator.browser.test.cjs [screenshot-dir]
const assert = require('node:assert/strict');
const { fakeConsole, launch } = require('../tests/helpers/fake-console.cjs');

(async () => {
  const shots = process.argv[2];
  const browser = await launch();
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
    const errors = [];
    const project = { id: 'p', organizationId: 'o', name: 'Workspace', config: {} };
    const running = { id: 'ceo', projectId: 'p', num: 3, title: 'Run the firm', workflow: 'software-dev', tags: [],
      params: { prompt: 'Grow the product', coordinator: { wakeHours: 24 } },
      lastView: { taskId: 'ceo', title: 'Run the firm', workflow: 'software-dev', stage: 'do', status: 'waiting',
        waitingFor: { kind: 'timer', summary: 'Checks in', detail: 'Checks in again within 24 hours', until: Date.now() + 3_600_000 },
        editableParams: ['coordinator'], messages: [], actions: [], state: {} } };
    const schema = [{ name: 'software-dev', params: [
      { name: 'prompt', type: 'text', label: 'Prompt', scopes: ['task'], bind: 'prompt' },
      { name: 'multiPr', type: 'boolean', label: 'Allow several branches per task', scopes: ['task'], bind: 'project', default: true },
    ], stages: [{ key: 'do', label: 'Working' }] }];
    const creates = [];
    const edits = [];
    await fakeConsole(context, { project, tasks: [running], schema, async api(p, request) {
      const method = request.method();
      if (p === '/api/projects/p/avatars') return { availability: { organization: true, project: 'inherit', effective: true }, avatars: [] };
      if (p === '/api/projects/p/tasks' && method === 'POST') {
        const body = request.postDataJSON();
        creates.push(body);
        return { id: 'task_new', projectId: 'p', title: 'New', workflow: 'software-dev', params: body.params || {} };
      }
      if (p.startsWith('/api/tasks/task_new')) return { id: 'task_new', projectId: 'p', params: {} };
      if (p === '/api/tasks/ceo' && method === 'GET') return running.lastView;
      if (p === '/api/tasks/ceo/params' && method === 'PATCH') { edits.push(request.postDataJSON()); return { applied: ['coordinator'] }; }
    } });
    context.setDefaultTimeout(8000);
    const page = await context.newPage();
    page.on('pageerror', (error) => { errors.push(error.message); console.error('page:', error.message); });

    await page.goto('http://console.test/org/workspace');
    // ── the list: a co-ordinator says so ──
    const row = page.locator('.task-row', { hasText: 'Run the firm' }).first();
    await row.waitFor();
    assert.match(await row.innerText(), /Co-ordinator/);
    assert.match(await row.innerText(), /Checks in at /, 'resting, it says when it checks in');
    if (shots) await row.screenshot({ path: `${shots}/coordinator-row.png` });

    // ── the form: the last row, after Avatār ──
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Shift+N');
    await page.locator('#tf-page').waitFor();
    await page.locator('#tf-page textarea[data-field="prompt"]').fill('Run this project like its CEO');
    const order = await page.evaluate(() => [...document.querySelectorAll('.tf-main > *')].map((node) => node.className).filter(Boolean));
    assert.deepEqual(order.slice(-2), ['tf-section tf-avatar', 'tf-section tf-coordinator'], 'the very bottom, after Avatār');
    const box = page.locator('#tf-coordinator');
    const hours = page.locator('#tf-coordinator-hours');
    assert.equal(await hours.isHidden(), true, 'its interval shows once ticked');
    await box.check();
    assert.equal(await hours.isVisible(), true);
    assert.equal(await hours.inputValue(), '24', 'pre-filled with 24 hours');
    // A co-ordinator always uses several branches: the toggle says so.
    const several = page.locator('[data-field="multiPr"]');
    assert.equal(await several.isChecked(), true);
    assert.equal(await several.isDisabled(), true, 'forced on while it is a co-ordinator');
    assert.equal(await page.locator('[data-row="multiPr"] .field-reset:visible').count(), 0, 'and nothing offers to reset it');
    await box.uncheck();
    assert.equal(await several.isDisabled(), false, 'unticked, the choice is back');
    await several.uncheck();
    await box.check();
    assert.equal(await several.isChecked(), true, 'ticked, it is on again');
    await box.uncheck();
    assert.equal(await several.isChecked(), false, 'and unticking restores what was chosen');
    await box.check();
    await hours.fill('1.5');
    assert.equal(await page.locator('.tf-coordinator .info-dot').count(), 1, 'what it does is a tooltip');
    if (shots) {
      await page.locator('.tf-coordinator').scrollIntoViewIfNeeded();
      await page.locator('.tf-main').screenshot({ path: `${shots}/coordinator-form.png` });
    }
    await page.locator('#tf-queue').click();
    await page.waitForFunction(() => true);
    for (let i = 0; i < 40 && !creates.some((body) => body.draft !== true && body.params?.coordinator); i++) await page.waitForTimeout(100);
    const run = creates.find((body) => body.params?.coordinator);
    assert.ok(run, 'the task is created with the setting');
    assert.deepEqual(run.params.coordinator, { wakeHours: 1.5 });

    // ── Parameters: its interval can be changed once it has started ──
    await page.goto('http://console.test/org/workspace/tasks/ceo/parameters');
    const interval = page.locator('#tp-params [data-field="coordinator"]');
    await interval.waitFor();
    assert.equal(await interval.inputValue(), '24');
    await interval.fill('0.5');
    await page.locator('#params-save').click();
    for (let i = 0; i < 40 && !edits.length; i++) await page.waitForTimeout(100);
    assert.deepEqual(edits[0], { params: { coordinator: { wakeHours: 0.5 } } });
    if (shots) await page.locator('#tp-params').screenshot({ path: `${shots}/coordinator-params.png` });
    assert.deepEqual(errors, []);
    console.log('ok — coordinator form row, forced branches, interval, list chip and Parameters edit');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
