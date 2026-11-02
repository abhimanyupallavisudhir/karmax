// A new task from the organization home asks which project it goes in — the
// list `n`'s templates use, numbered in the sidebar's order: a number picks at
// once (unless a longer number starts with it), letters narrow the list, Enter
// takes the highlighted project, at first the one new tasks went to last.
// - New task…, Send and N ask, then open the form there;
// - n and the template button ask, then list that project's templates;
// - a home narrowed to one project (project:…) does not ask;
// - a project's page never asks.
// Run: node web/new-task-project.browser.test.cjs [screenshot-dir]
const assert = require('node:assert/strict');
const { fakeConsole, launch } = require('../tests/helpers/fake-console.cjs');

(async () => {
  const shots = process.argv[2];
  const browser = await launch();
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 800 } });
    const errors = [];
    const web = { id: 'p', organizationId: 'o', name: 'Website', config: {} };
    const mobile = { id: 'q', organizationId: 'o', name: 'Mobile App', config: {} };
    const api = { id: 'r', organizationId: 'o', name: 'API', folder: 'backend', config: {} };
    const db = { id: 's', organizationId: 'o', name: 'Database', folder: 'backend', config: {} };
    const schema = [{ name: 'software-dev', params: [{ name: 'prompt', type: 'text', label: 'Prompt', scopes: ['task'], bind: 'prompt' }], stages: [{ key: 'do', label: 'Do' }] }];
    const templates = { p: [], r: [], s: [], q: [{ id: 'tmpl_q', organizationId: 'o', projectId: 'q', name: 'Store listing', workflow: 'software-dev', params: { prompt: 'Refresh the store listing' }, createdAt: 1 }] };
    const empty = { tasks: [], total: 0, offset: 0, limit: 200, projects: [], tags: [] };
    await fakeConsole(context, { project: web, schema, async api(p) {
      if (p === '/api/projects') return [web, api, mobile, db];
      if (p === '/api/projects/q') return mobile;
      if (p === '/api/projects/r') return api;
      if (p === '/api/projects/s') return db;
      if (p === '/api/organizations/o/search' || /^\/api\/projects\/[pqrs]\/search$/.test(p)) return empty;
      if (/^\/api\/projects\/[qrs]\/tasks$/.test(p)) return [];
      const listed = p.match(/^\/api\/projects\/([pqrs])\/templates$/)?.[1];
      if (listed) return templates[listed];
    } });
    context.setDefaultTimeout(8000);
    const page = await context.newPage();
    page.on('pageerror', (error) => { errors.push(error.message); console.error('page:', error.message); });
    const options = () => page.locator('#pp-list .opt').evaluateAll((rows) => rows.map((row) =>
      `${row.querySelector('.tpl-num').textContent} ${row.querySelector('.tpl-name').textContent}`));
    const highlighted = () => page.locator('#pp-list .opt.active .tpl-name').innerText();
    const formProject = () => page.locator('#tf-project').innerText();
    const closeForm = async () => { await page.keyboard.press('Escape'); await page.locator('#tf-page').waitFor({ state: 'detached' }); };
    const home = async (query = '') => {
      await page.goto(`http://console.test/org${query}`);
      await page.locator('#expand-task').waitFor();
      await page.evaluate(() => document.activeElement?.blur());
    };

    // ── New task… asks; the list is numbered in the sidebar's order ──
    await home();
    await page.locator('#expand-task').click();
    await page.locator('#pp-in').waitFor();
    assert.equal(await page.locator('#tf-page').count(), 0, 'no form before a project is chosen');
    const numbered = ['1 Website', '2 backend/API', '3 backend/Database', '4 Mobile App'];
    assert.deepEqual(await options(), numbered, 'numbered as the sidebar lists them, folders in the name');
    assert.equal(await page.locator('#pp-in').getAttribute('placeholder'), 'New task in…');
    if (shots) await page.screenshot({ path: `${shots}/new-task-project-picker.png` });
    // A number nothing longer starts with picks at once.
    await page.keyboard.press('4');
    await page.locator('#tf-page').waitFor();
    assert.equal(await page.locator('#pp-in').count(), 0, 'the picker closes');
    assert.equal(await formProject(), 'Mobile App', 'the form opens in the project picked');
    await closeForm();

    // ── the choice is remembered: Enter takes it next time, numbers stay put ──
    await page.locator('#add-task').click();
    await page.locator('#pp-in').waitFor();
    assert.deepEqual(await options(), numbered, 'the remembered project keeps its number');
    assert.equal(await highlighted(), 'Mobile App', 'the project last chosen is highlighted');
    await page.keyboard.press('Enter');
    await page.locator('#tf-page').waitFor();
    assert.equal(await formProject(), 'Mobile App');
    await closeForm();

    // ── letters narrow the list; arrows move; Escape changes nothing ──
    await page.keyboard.press('Shift+N');
    await page.locator('#pp-in').waitFor();
    await page.keyboard.type('back');
    assert.deepEqual(await options(), ['2 backend/API', '3 backend/Database'], 'a folder name matches too');
    await page.locator('#pp-in').fill('');
    await page.locator('#pp-in').press('ArrowUp');
    assert.equal(await highlighted(), 'backend/Database', 'arrows move from the remembered project');
    await page.keyboard.press('Escape');
    await page.locator('#pp-in').waitFor({ state: 'detached' });
    assert.equal(await page.locator('#tf-page').count(), 0, 'Escape opens nothing');
    await page.keyboard.press('Shift+N');
    await page.locator('#pp-in').waitFor();
    await page.keyboard.type('webs');
    await page.keyboard.press('Enter');
    await page.locator('#tf-page').waitFor();
    assert.equal(await formProject(), 'Website');
    await closeForm();

    // ── n asks for the project, then lists that project's templates ──
    await page.keyboard.press('n');
    await page.locator('#pp-in').waitFor();
    assert.equal(await highlighted(), 'Website', 'the last choice, again');
    await page.keyboard.press('4');
    await page.locator('#tpl-in').waitFor();
    await page.waitForFunction(() => document.querySelectorAll('#tpl-list .opt').length === 2);
    await page.keyboard.press('1');
    await page.locator('#tf-page').waitFor();
    assert.equal(await formProject(), 'Mobile App');
    assert.equal(await page.locator('#tf-page textarea[data-field="prompt"]').inputValue(), 'Refresh the store listing', 'Mobile App’s template');
    await closeForm();
    await page.locator('#new-from-template').click();
    await page.locator('#pp-in').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('#pp-in').waitFor({ state: 'detached' });
    assert.equal(await page.locator('#tpl-in').count(), 0, 'the template button asks first too');

    // ── a home narrowed to one project creates there without asking ──
    await home('?q=project:website');
    await page.locator('#expand-task').click();
    await page.locator('#tf-page').waitFor();
    assert.equal(await page.locator('#pp-in').count(), 0, 'no picker');
    assert.equal(await formProject(), 'Website');
    await closeForm();

    // ── a project's page is the project ──
    await page.goto('http://console.test/org/website');
    await page.locator('#expand-task').click();
    await page.locator('#tf-page').waitFor();
    assert.equal(await page.locator('#pp-in').count(), 0, 'no picker');
    assert.equal(await formProject(), 'Website');
    await closeForm();

    assert.deepEqual(errors, []);
    console.log('new-task-project: ok');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
