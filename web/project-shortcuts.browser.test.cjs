// `p n` (new project) and `p /` (search projects) work from anywhere in the
// console, not only once the projects rail has focus — and they leave the task
// list's `n` (new task) and `/` (search tasks) alone, in the rail too. A folded
// sidebar unfolds for `p /`, since its search box can't take focus while hidden.
// Run: node web/project-shortcuts.browser.test.cjs
const assert = require('node:assert/strict');
const { fakeConsole, launch } = require('../tests/helpers/fake-console.cjs');

(async () => {
  const browser = await launch();
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 800 } });
    const errors = [];
    const project = { id: 'p', organizationId: 'o', name: 'Workspace', config: {} };
    const task = { id: 't', projectId: 'p', num: 1, title: 'Ship it', workflow: 'software-dev', params: {}, tags: [], lastView: { stage: 'review', status: 'active' } };
    const schema = [{ name: 'software-dev', params: [], stages: [{ key: 'review', label: 'Review' }] }];
    await fakeConsole(context, { project, tasks: [task], schema, api(p) {
      if (p === '/api/user/app-grants') return { grants: [], levels: [] };
    } });
    context.setDefaultTimeout(8000);
    const page = await context.newPage();
    page.on('pageerror', error => { errors.push(error.message); console.error('page:', error.message); });
    const open = async () => {
      await page.goto('http://console.test/org/workspace');
      await page.locator('[data-id="t"]').waitFor();
      await page.evaluate(() => document.activeElement?.blur());
    };
    const focused = () => page.evaluate(() => document.activeElement?.id || '');
    const dialog = page.locator('.new-project-dialog');

    // From the task list, with nothing focused.
    await open();
    await page.keyboard.press('p');
    await page.keyboard.press('n');
    await dialog.waitFor();
    assert.equal(await focused(), 'new-project-name', 'p n opens New project');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });

    await open();
    await page.keyboard.press('p');
    await page.keyboard.press('/');
    await page.waitForFunction(() => document.activeElement?.id === 'project-search');
    assert.equal(await page.locator('#tf-page').count(), 0, 'p / opens no task form');

    // From inside the rail (g P): the same keys, and bare n / / are the task list's again.
    await open();
    await page.keyboard.press('g');
    await page.keyboard.press('Shift+P');
    await page.waitForFunction(() => !!document.activeElement?.closest('#rail'));
    await page.keyboard.press('p');
    await page.keyboard.press('n');
    await dialog.waitFor();
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    await page.waitForFunction(() => !!document.activeElement?.closest('#rail'));
    await page.keyboard.press('/');
    await page.waitForFunction(() => document.activeElement?.id === 'task-search');

    await open();
    await page.keyboard.press('g');
    await page.keyboard.press('Shift+P');
    await page.waitForFunction(() => !!document.activeElement?.closest('#rail'));
    await page.keyboard.press('n');
    await page.locator('#tpl-in').waitFor();
    assert.equal(await dialog.count(), 0, 'bare n in the rail is New task, not New project');
    await page.keyboard.press('Enter');
    await page.locator('#tf-page').waitFor();

    // A folded sidebar unfolds for p /.
    await open();
    await page.locator('#mobile-menu').click();
    await page.waitForFunction(() => document.documentElement.classList.contains('rail-collapsed'));
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('p');
    await page.keyboard.press('/');
    await page.waitForFunction(() => document.activeElement?.id === 'project-search');
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('rail-collapsed')), false);

    // The help panel and the controls' tooltips teach the new keys.
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('?');
    const help = await page.locator('.palette').innerText();
    assert.match(help, /p n\s+New project/);
    assert.match(help, /p \/\s+Search projects/);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#new-project').getAttribute('title'), 'New project (p n)');
    assert.equal(await page.locator('#project-search').getAttribute('title'), 'Search projects (p /)');
    await page.locator('#new-project').click();
    await page.waitForFunction(() => document.querySelector('#key-echo')?.textContent === 'p n');

    assert.deepEqual(errors, []);
    console.log('Project shortcuts: ok');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
