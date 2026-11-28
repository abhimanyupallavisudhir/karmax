// A permanent co-ordinator in the full console shell (wiki features/coordinator),
// with trusted Chromium input: the task form's last row, after Avatār — ticking
// it reveals its check-in interval, pre-filled with 24 hours, which takes
// decimals; the task is created with it; and its row in the list says so. Its
// role is its prompt: ticking puts it there (above anything written), Reset to
// default brings it back, and the conversation shows it as its first message.
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
    // Its role is its prompt (wiki features/coordinator § Role prompt).
    const ROLE = "You are this project's CEO: its permanent co-ordinator.\n\nSo don't make changes yourself.";
    const marker = { kind: 'project', version: 1, hash: 'abcd1234' };
    // Started before the role was its prompt: the role shows above what it started with.
    const legacy = { id: 'old', projectId: 'p', num: 4, title: 'CEO (Project Co-ordinator)', workflow: 'software-dev', tags: [], createdAt: 1,
      params: { prompt: ROLE, coordinator: { wakeHours: 24 }, _rolePrompt: { ...marker, outsideConversation: true } },
      lastView: { taskId: 'old', title: 'CEO (Project Co-ordinator)', workflow: 'software-dev', stage: 'do', status: 'active',
        messages: [{ id: 'm0', role: 'user', text: 'Plan the launch', ts: 2 }, { id: 'u1', role: 'user', text: 'Also hire a designer', ts: 3, author: 'user:u', authorLabel: 'Ana' }],
        actions: [], state: {} } };
    // Started with an older role text nobody edited: its first message is the role as it reads now.
    const refreshed = { id: 'new', projectId: 'p', num: 5, title: 'CEO (Organization Co-ordinator)', workflow: 'software-dev', tags: [], createdAt: 1,
      params: { prompt: ROLE, coordinator: { wakeHours: 24 }, _rolePrompt: marker },
      lastView: { taskId: 'new', title: 'CEO (Organization Co-ordinator)', workflow: 'software-dev', stage: 'do', status: 'active',
        messages: [{ id: 'm0', role: 'user', text: 'An older role text', ts: 2 }], actions: [], state: {} } };
    // A CEO draft whose old Ask the migration moved out of its prompt: it waits as its first message.
    const draftCeo = { id: 'draftceo', projectId: 'p', title: 'CEO (Project Co-ordinator)', workflow: 'software-dev', tags: [], createdAt: 1,
      params: { draft: true, prompt: ROLE, coordinator: { wakeHours: 24 }, _rolePrompt: marker } };
    const schema = [{ name: 'software-dev', params: [
      { name: 'prompt', type: 'text', label: 'Prompt', scopes: ['task'], bind: 'prompt' },
      { name: 'multiPr', type: 'boolean', label: 'Allow several branches per task', scopes: ['task'], bind: 'project', default: true },
    ], stages: [{ key: 'do', label: 'Working' }] }];
    const creates = [];
    const edits = [];
    await fakeConsole(context, { project, tasks: [running, legacy, refreshed, draftCeo], schema, async api(p, request) {
      const method = request.method();
      if (p === '/api/projects/p/coordinator-role') return { kind: 'project', version: 1, prompt: ROLE };
      if (p === '/api/projects/p/coordinator-role?taskId=draftceo') return { kind: 'project', version: 1, prompt: ROLE };
      if (p === '/api/tasks/draftceo/pending-messages') return { pendingMessages: [{ role: 'do',
        message: { id: 'u9', role: 'user', text: 'Plan the launch', ts: 1, author: 'user:ana', authorLabel: 'Ana' } }] };
      if (p === '/api/tasks/old' && method === 'GET') return legacy.lastView;
      if (p === '/api/tasks/new' && method === 'GET') return refreshed.lastView;
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
    const promptBox = page.locator('#tf-page textarea[data-field="prompt"]');
    const roleReset = page.locator('#tf-role-reset');
    // ── its role is its prompt: ticking fills an empty prompt, Reset brings it back, unticking takes it out ──
    await page.locator('#tf-coordinator').check();
    await page.waitForFunction((role) => document.querySelector('#tf-page textarea[data-field="prompt"]').value === role, ROLE);
    assert.equal(await roleReset.isHidden(), true, 'untouched, nothing to reset');
    await promptBox.press('End');
    await promptBox.type(' Be frugal.');
    await roleReset.waitFor({ state: 'visible' });
    assert.match(await roleReset.getAttribute('title'), /keeps up with improvements/, 'what it does is a tooltip');
    assert.equal(await page.locator('[data-row="prompt"] .field-reset:visible').count(), 1, 'one Reset, to the role');
    if (shots) await page.locator('[data-row="prompt"]').screenshot({ path: `${shots}/coordinator-role-edited.png` });
    await roleReset.click();
    assert.equal(await promptBox.inputValue(), ROLE);
    assert.equal(await roleReset.isHidden(), true);
    if (shots) await page.locator('[data-row="prompt"]').screenshot({ path: `${shots}/coordinator-role-prompt.png` });
    await page.locator('#tf-coordinator').uncheck();
    await page.waitForFunction(() => document.querySelector('#tf-page textarea[data-field="prompt"]').value === '');
    assert.equal(await roleReset.isHidden(), true, 'not a co-ordinator: no role to reset to');
    await promptBox.fill('Run this project like its CEO');
    const order = await page.evaluate(() => [...document.querySelectorAll('.tf-main > *')].map((node) => node.className).filter(Boolean));
    assert.deepEqual(order.slice(-2), ['tf-section tf-avatar', 'tf-section tf-coordinator'], 'the very bottom, after Avatār');
    const box = page.locator('#tf-coordinator');
    const hours = page.locator('#tf-coordinator-hours');
    assert.equal(await hours.isHidden(), true, 'its interval shows once ticked');
    await box.check();
    // What was written stays, under the role.
    await page.waitForFunction((role) => document.querySelector('#tf-page textarea[data-field="prompt"]').value === `${role}\n\nRun this project like its CEO`, ROLE);
    assert.equal(await hours.isVisible(), true);
    assert.equal(await hours.inputValue(), '24', 'pre-filled with 24 hours');
    // A co-ordinator always uses several branches: the toggle says so.
    const several = page.locator('[data-field="multiPr"]');
    assert.equal(await several.isChecked(), true);
    assert.equal(await several.isDisabled(), true, 'forced on while it is a co-ordinator');
    assert.equal(await page.locator('[data-row="multiPr"] .field-reset:visible').count(), 0, 'and nothing offers to reset it');
    await box.uncheck();
    await page.waitForFunction(() => document.querySelector('#tf-page textarea[data-field="prompt"]').value === 'Run this project like its CEO');
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

    // ── the conversation: the role is its first message ──
    await page.goto('http://console.test/org/workspace/tasks/old');
    const thread = page.locator('#ck-thread');
    await thread.getByText('Also hire a designer').waitFor();
    const said = await thread.innerText();
    assert.ok(said.indexOf("So don't make changes yourself.") >= 0, 'the role is shown');
    assert.ok(said.indexOf("So don't make changes yourself.") < said.indexOf('Plan the launch'), 'above what it started with');
    assert.ok(said.indexOf('Plan the launch') < said.indexOf('Also hire a designer'));
    if (shots) await thread.screenshot({ path: `${shots}/coordinator-role-conversation.png` });
    await page.goto('http://console.test/org/workspace/tasks/new');
    await thread.getByText("So don't make changes yourself.").waitFor();
    assert.equal(await thread.getByText('An older role text').count(), 0, 'the role as it reads now, once');

    // ── a draft: its role is its prompt, and what waits for it shows under it, by whom ──
    await page.goto('http://console.test/org/workspace/tasks/draftceo');
    const waiting = page.locator('#tf-page .tf-pending .msg.pending');
    await waiting.waitFor();
    assert.equal(await page.locator('#tf-page textarea[data-field="prompt"]').inputValue(), ROLE);
    assert.match(await waiting.innerText(), /Ana[\s\S]*Plan the launch/);
    assert.match(await waiting.locator('.pending-mark').getAttribute('title'), /once the task starts/, 'what it is is a tooltip');
    if (shots) {
      await page.waitForTimeout(500); // the page's entrance fades
      const prompt = await page.locator('[data-row="prompt"]').boundingBox();
      const queued = await page.locator('.tf-pending').boundingBox();
      await page.screenshot({ path: `${shots}/coordinator-draft-pending.png`,
        clip: { x: prompt.x, y: prompt.y, width: prompt.width, height: queued.y + queued.height - prompt.y + 4 } });
    }

    assert.deepEqual(errors, []);
    console.log('ok — coordinator form row, role prompt, forced branches, interval, list chip, Parameters edit and conversation');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
