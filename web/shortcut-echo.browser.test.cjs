// The topbar's shortcut echo: whatever the person just did — by mouse, palette
// or keys — shows its keyboard shortcut next to their profile link, so they
// learn the keys by using the console. Full shell, trusted Chromium input.
// Run: node web/shortcut-echo.browser.test.cjs
const assert = require('node:assert/strict');
const { fakeConsole, launch, taskView } = require('../tests/helpers/fake-console.cjs');

(async () => {
  const browser = await launch();
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const errors = [];
    const project = { id: 'p', organizationId: 'o', name: 'Workspace', config: {} };
    const task = { id: 't', projectId: 'p', num: 1, title: 'Ship it', workflow: 'software-dev', params: {}, tags: [], lastView: { stage: 'review', status: 'active' } };
    const schema = [{ name: 'software-dev', params: [], stages: [{ key: 'review', label: 'Review' }] }];
    const commands = [
      { id: 'nav.home', title: 'Go home', keybinding: 'g H', workflow: 'core' },
      { id: 'nav.close', title: 'Close panel', keybinding: 'Escape', workflow: 'core' },
      { id: 'task.confirm', title: 'Confirm PR', keybinding: 'c', workflow: 'software-dev' },
    ];
    await fakeConsole(context, { project, tasks: [task], schema, api(p) {
      if (p === '/api/contributions') return { slots: [], commands, events: [] };
      if (p === '/api/user/app-grants') return { grants: [], levels: [] };
      if (p === '/api/tasks/t') return taskView(task, { actions: [{ name: 'confirm', label: 'Confirm', enabled: true }, { name: 'cancel', label: 'Cancel', enabled: true }] });
    } });
    context.setDefaultTimeout(8000);
    const page = await context.newPage();
    page.on('pageerror', error => { errors.push(error.message); console.error('page:', error.message); });
    await page.goto('http://console.test/org/workspace');
    await page.locator('[data-id="t"]').waitFor();

    const echo = page.locator('#key-echo');
    const shows = async (keys, title) => {
      await page.waitForFunction(k => document.querySelector('#key-echo')?.textContent === k, keys);
      assert.ok(await echo.isVisible(), `${keys} is visible`);
      if (title) assert.equal(await echo.getAttribute('title'), title);
    };

    // It leads the topbar's right-hand cluster (⌘ ? profile 🔔) — appearing
    // there shifts none of those buttons — and is invisible until something happens.
    assert.equal(await page.evaluate(() => document.querySelector('#key-echo').nextElementSibling?.id), 'topbar-palette');
    assert.equal(await echo.textContent(), '');
    assert.equal(await echo.isVisible(), false, 'nothing to show before the first action');

    // Mouse: a project tab, the profile link, the inbox bell, the search box.
    await page.locator('.tab[data-tab="queue"]').click();
    await shows('g q', 'Go to queues');
    await page.locator('#topbar-user').click();
    await shows('g A', 'Go to your profile');
    await page.locator('#bell').click();
    await shows('g N', 'Go to inbox');
    await page.goto('http://console.test/org/workspace');
    await page.locator('[data-id="t"]').waitFor();
    await page.locator('#task-search').click();
    await shows('/', 'Search tasks');

    // Keys: the pending chord prefix shows at once, then the whole chord.
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press('g');
    await shows('g');
    await page.keyboard.press('Shift+H');
    await shows('g H', 'Go home');
    await page.waitForURL(url => !url.pathname.includes('/workspace'));
    // `g h` is no longer home: nothing runs, and the dangling prefix clears.
    await page.goto('http://console.test/org/workspace');
    await page.locator('[data-id="t"]').waitFor();
    const at = page.url();
    await page.keyboard.press('g');
    await page.keyboard.press('h');
    await page.waitForFunction(() => document.querySelector('#key-echo').textContent === '');
    assert.equal(page.url(), at, 'g h does nothing');

    // Palette: running a command from it teaches that command's keys.
    await page.locator('#topbar-palette').click();
    await shows('Ctrl+k', 'Command palette');
    await page.locator('#pal-in').fill('go to queues');
    await page.locator('#pal-in').press('Enter');
    await shows('g q', 'Go to queues');

    // A task page: an action button echoes its workflow binding, else its digit;
    // the back arrow echoes Esc.
    await page.goto('http://console.test/org/workspace');
    await page.locator('[data-id="t"] .row-link').click();
    await page.locator('#tp-foot [data-act="confirm"]').waitFor();
    await page.locator('#tp-foot [data-act="cancel"]').click(); // its confirm() dialog is dismissed
    await shows('2', 'Cancel');
    await page.locator('#tp-foot [data-act="confirm"]').click();
    await shows('c', 'Confirm');
    await page.locator('#tp-back').click();
    await shows('Esc', 'Close panel');

    // It fades out on its own.
    await page.waitForFunction(() => document.querySelector('#key-echo').textContent === '', null, { timeout: 5000 });
    assert.equal(await echo.isVisible(), false);
    assert.deepEqual(errors, []);
    console.log('Shortcut echo: ok');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
