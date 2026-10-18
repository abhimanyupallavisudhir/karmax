// Numbered shortcut families and the keys every dialog shares, in the full
// shell with trusted Chromium input:
// - `v 1`…`v 9` switch the list's view; while `v` is pending each chip wears its
//   number (and the topbar echo shows the prefix); `v s` saves the search as a
//   view — on the organization home too, where views belong to the organization;
// - `. 1`…`. 9` press a task's tool buttons (Share, Fork, …, Full screen) and a
//   project's Work locally, numbered in the order they show;
// - ⌘/Ctrl+Enter presses the open dialog's main button;
// - the "?" panel lists all of it.
// Run: node web/shortcut-chords.browser.test.cjs [screenshot-dir]
const assert = require('node:assert/strict');
const { fakeConsole, launch, taskView } = require('../tests/helpers/fake-console.cjs');

(async () => {
  const shots = process.argv[2];
  const browser = await launch();
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 800 } });
    const errors = [];
    const project = { id: 'p', organizationId: 'o', name: 'Workspace', config: {} };
    const task = { id: 't', projectId: 'p', num: 1, title: 'Ship it', workflow: 'software-dev', params: {}, tags: [], lastView: { stage: 'review', status: 'active' } };
    const schema = [{ name: 'software-dev', params: [], stages: [{ key: 'review', label: 'Review' }] }];
    const orgViews = [{ id: 'view_bugs', projectId: '', organizationId: 'o', name: 'Bugs', query: { text: 'bug' }, order: 0, createdAt: 1 }];
    const created = [];
    let hosted = false;
    await fakeConsole(context, { project, tasks: [task], schema, async api(p, request) {
      if (p === '/api/meta') return { siteName: 'Fixture', hostLocal: !hosted, hosted, consoleRevision: 'one', agent: { provider: 'mock' }, worldProviders: [] };
      if (p === '/api/organizations/o/search') return { tasks: [task], total: 1, offset: 0, limit: 200, tags: [], projects: [{ id: 'p', name: 'Workspace', organizationId: 'o' }] };
      if (p === '/api/organizations/o/views' && request.method() === 'POST') {
        const view = { id: `view_${created.length}`, projectId: '', organizationId: 'o', order: orgViews.length, createdAt: 2, ...request.postDataJSON() };
        created.push(request.postDataJSON());
        orgViews.push(view);
        return view;
      }
      if (p === '/api/organizations/o/views') return orgViews;
      if (p === '/api/tasks/t') return taskView(task, { actions: [{ name: 'confirm', label: 'Confirm', enabled: true }],
        transcripts: [{ role: 'do', label: 'Agent', messages: [{ id: 'm', role: 'user', text: 'Ship it' }] }] });
    } });
    context.setDefaultTimeout(8000);
    const page = await context.newPage();
    page.on('pageerror', (error) => { errors.push(error.message); console.error('page:', error.message); });
    const echoIs = (keys) => page.waitForFunction((k) => document.querySelector('#key-echo')?.textContent === k, keys);
    const hints = () => page.locator('#chord-hints .chord-hint').allInnerTexts();

    // ── the organization home's views ──
    await page.goto('http://console.test/org');
    await page.locator('.view-chip[data-view="view_bugs"]').waitFor();
    const chipNames = await page.locator('.views-bar .view-chip[data-view]').allInnerTexts();
    assert.deepEqual(chipNames.map((name) => name.replace('✕', '').trim()), ['For me', 'Active', 'Scheduled', 'Repeatable', 'Archived', 'Task store', 'Bugs'],
      'the home shows the organization’s saved views after the built-in ones and the Task store');
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('v');
    await echoIs('v');
    assert.deepEqual(await hints(), ['1', '2', '3', '4', '5', '6', '7'], 'pressing v numbers every view chip');
    if (shots) await page.screenshot({ path: `${shots}/view-hints.png` });
    await page.keyboard.press('3');
    await echoIs('v 3');
    await page.waitForFunction(() => new URL(location.href).searchParams.get('q')?.includes('is:scheduled'));
    assert.equal(await page.locator('#chord-hints').count(), 0, 'the badges go once the chord completes');
    assert.ok(await page.locator('.view-chip.active[data-view="builtin:scheduled"]').count(), 'v 3 is Scheduled');
    await page.keyboard.press('v');
    await page.keyboard.press('6');
    await page.waitForFunction(() => new URL(location.href).searchParams.get('q') === 'is:store');
    assert.ok(await page.locator('.view-chip.active[data-view="__store__"]').count(), 'v 6 is the Task store');
    await page.keyboard.press('v');
    await page.keyboard.press('7');
    await page.waitForFunction(() => new URL(location.href).searchParams.get('q') === 'bug');
    assert.ok(await page.locator('.view-chip.active[data-view="view_bugs"]').count(), 'v 7 is the saved view');
    await page.keyboard.press('v');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#chord-hints').count(), 0, 'Esc drops a pending prefix and its badges');

    // ⌘/Ctrl+Enter in the search box has no form to submit: nothing happens.
    await page.locator('#task-search').focus();
    await page.keyboard.press('Control+Enter');
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#tf-page').count(), 0, 'Ctrl+Enter in the search box does not open the task form');
    await page.evaluate(() => document.activeElement?.blur());

    // Save the search as a view, from the keyboard, on the home.
    assert.equal(await page.locator('#save-view').count(), 0, 'a query that is already a view offers no Save');
    await page.locator('#task-search').fill('tag:urgent');
    await page.locator('#save-view').waitFor();
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('v');
    assert.ok((await hints()).includes('s'), 'Save view wears s');
    await page.keyboard.press('s');
    const prompt = page.locator('dialog.text-prompt');
    await prompt.waitFor();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('Urgent');
    await page.keyboard.press('Enter');
    await page.locator('.view-chip.active', { hasText: 'Urgent' }).waitFor();
    assert.equal(created.length, 1);
    assert.equal(created[0].name, 'Urgent');
    assert.ok(JSON.stringify(created[0].query).includes('urgent'), 'the view keeps the query');
    assert.equal(await page.locator('#save-view').count(), 0, 'and it is a view now');
    await page.keyboard.press('v');
    assert.deepEqual(await hints(), ['1', '2', '3', '4', '5', '6', '7', '8'], 'the new view takes the next number');
    await page.keyboard.press('Escape');

    // ── the task page's tool buttons ──
    await page.goto('http://console.test/org/workspace/tasks/1');
    await page.locator('#share-task-conversation').waitFor();
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('.');
    await echoIs('.');
    const tools = await page.locator('[data-tool]').evaluateAll((els) => els.filter((el) => el.getClientRects().length).map((el) => el.dataset.tool));
    assert.deepEqual(tools, ['Share', 'Fork', 'Full screen'], 'self-hosted: Share, Fork, Full screen');
    assert.deepEqual(await hints(), ['1', '2', '3'], 'pressing . numbers the tool buttons');
    if (shots) await page.screenshot({ path: `${shots}/tool-hints.png` });
    await page.keyboard.press('3');
    await page.locator('.ck-pane.ck-fullscreen').waitFor();
    await echoIs('. 3');
    await page.keyboard.press('Escape');
    await page.locator('.ck-pane.ck-fullscreen').waitFor({ state: 'detached' });
    // A click on a tool teaches its number.
    await page.locator('#conversation-fullscreen').click();
    await echoIs('. 3');
    await page.keyboard.press('Escape');

    // ── ⌘/Ctrl+Enter presses a dialog's main button ──
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('p');
    await page.keyboard.press('n');
    const name = page.locator('#new-project-name');
    await name.waitFor();
    await name.fill('Keyboard project');
    let posted = null;
    await page.route('http://console.test/api/organizations/o/projects', (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      posted = route.request().postDataJSON();
      return route.fulfill({ status: 500, json: { error: 'stop here' } });
    });
    await page.keyboard.press('Control+Enter');
    await page.waitForFunction(() => document.querySelector('#key-echo')?.textContent === 'Ctrl+↵');
    await page.waitForFunction(() => !!document.querySelector('.new-project-error:not([hidden])'));
    assert.equal(posted?.name, 'Keyboard project', 'Ctrl+Enter submits the dialog');
    await page.keyboard.press('Escape');

    // ── the "?" panel lists every family ──
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Shift+?');
    const help = page.locator('.help-panel');
    await help.waitFor();
    const text = await help.innerText();
    for (const line of ['v 1–9', 'Switch view', 'v s', 'Save search as view', '. 1–9', 'Share, Fork, Work locally, Full screen',
      'Ctrl+↵', 'Save, apply or send', 'g V', 'Go to passwords & payments', 'Esc'])
      assert.ok(text.includes(line), `help lists “${line}”`);
    if (shots) await help.screenshot({ path: `${shots}/help.png` });
    await page.keyboard.press('Escape');

    // ── hosted: a project's Work locally is `. 1` ──
    hosted = true;
    await page.goto('http://console.test/org/workspace');
    await page.locator('#project-local-checkout').waitFor();
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('.');
    assert.deepEqual(await hints(), ['1'], 'the project page has one tool: Work locally');
    await page.keyboard.press('1');
    await page.getByRole('heading', { name: 'Work locally' }).or(page.locator('.local-handoff-scrim')).first().waitFor();

    assert.deepEqual(errors, []);
    console.log('Shortcut chords: ok');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exit(1); });
