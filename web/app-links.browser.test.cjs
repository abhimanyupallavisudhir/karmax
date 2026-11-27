// Real browser regression: an agent's link to another task of the console opens
// it in place (a history entry, no new tab), while a link to another site still
// opens in a new tab and a relative link still opens the cited file.
// Run: node web/app-links.browser.test.cjs [screenshot.png]
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = __dirname;

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1200, height: 760 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const popups = [];
    context.on('page', (p) => popups.push(p.url()));
    const record = { id: 't1', projectId: 'p1', num: 4, title: 'Dark-mode toggle', workflow: 'software-dev', attemptNumber: 1, tags: [],
      params: { prompt: 'Add it' }, lastView: { taskId: 't1', stage: 'do', status: 'waiting' } };
    const reply = 'Done. It needed the theme tokens from [#7 Theme tokens](http://links.test/test/project/tasks/7), '
      + 'so I noted it on the [deploy guide](http://links.test/test/project/wiki#guides/deploy) and in [Environment](http://links.test/test/project/settings#project-environment). '
      + 'Upstream: [PR #3](https://github.com/acme/site/pull/3). Changed [src/theme.ts](src/theme.ts).';
    const view = {
      taskId: 't1', num: 4, title: record.title, workflow: 'software-dev', stage: 'do', status: 'waiting',
      waitingFor: { kind: 'human' }, state: {}, branch: 'tavya/t1', targetBranch: 'main', subTasks: [],
      notes: '', editableParams: [], agents: {}, worldAvailable: true, worldPath: '/home/user/site',
      actions: [{ name: 'followUp', enabled: true, args: ['text'] }],
      messages: [{ id: 'm0', role: 'user', text: 'Add a dark-mode toggle', ts: 1 }, { id: 'm1', role: 'agent', text: reply, ts: 2 }],
    };
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://links.test') return route.abort();
      const p = url.pathname;
      if (p.startsWith('/api/')) {
        let data = [];
        if (p === '/api/tasks/t1') data = view;
        else if (p.endsWith('/attempts')) data = { intentId: 'i1', principalAttemptId: 't1', attempts: [record] };
        else if (p.endsWith('/sessions')) data = {};
        else if (p.includes('/defaults/')) data = { task: { inherited: {} } };
        else if (p.includes('explanation-settings')) data = { effective: { enabled: false } };
        return route.fulfill({ json: data });
      }
      const file = path.join(root, p === '/' ? 'index.html' : p);
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.abort();
      let body = fs.readFileSync(file, 'utf8');
      if (p === '/app.js') body = body.replace(/^boot\(\)\.catch\(.*$/m, 'window.linkTest = { S, openTask }; installLinkRouter();');
      return route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    await page.goto('http://links.test/');
    await page.waitForFunction(() => window.linkTest);
    const open = () => page.evaluate(async (record) => {
      const { S, openTask } = window.linkTest;
      document.querySelector('#app').innerHTML = '<main id="main" style="height:740px;display:flex;flex-direction:column"></main>';
      S.tasks = [record]; S.projects = [{ id: 'p1', name: 'Project', organizationId: 'o1', config: {} }];
      S.projectId = 'p1'; S.organizationId = 'o1'; S.organizations = [{ id: 'o1', name: 'Test', slug: 'test' }]; S.tags = [];
      S.meta = { workflows: [], hosted: true }; S.schema = [{ name: 'software-dev', params: [] }];
      S.selected = null; S.view = null; S.taskTab = null;
      await openTask('t1');
    }, record);
    await open();
    const task = page.locator('a', { hasText: '#7 Theme tokens' });
    await task.waitFor();
    if (process.argv[2]) {
      await page.locator('.msg', { hasText: 'Theme tokens' }).last().scrollIntoViewIfNeeded().catch(() => {});
      await page.screenshot({ path: process.argv[2] });
    }
    // Navigations are recorded, not performed.
    await page.evaluate(() => { window.pushes = []; history.pushState = (state, title, url) => window.pushes.push(url); });

    await task.click();
    await page.waitForTimeout(100);
    assert.deepEqual(await page.evaluate(() => window.pushes), ['/test/project/tasks/7'], 'the task link opens in place');
    await open();
    await page.evaluate(() => { window.pushes = []; });
    await page.locator('a', { hasText: 'deploy guide' }).click();
    await page.waitForTimeout(100);
    assert.deepEqual(await page.evaluate(() => window.pushes), ['/test/project/wiki#guides/deploy'], 'a wiki page opens in place at its entry');

    await open();
    assert.equal(await page.locator('a', { hasText: 'PR #3' }).getAttribute('target'), '_blank', 'another site still opens in a new tab');
    assert.match(await page.locator('a', { hasText: 'src/theme.ts' }).getAttribute('href'), /^\/test\/project\/tasks\/4\/file\?path=src%2Ftheme\.ts$/,
      'a relative link still cites a file in the task\'s world');
    assert.deepEqual(popups, [], 'no new tab was opened');
    assert.deepEqual(errors.filter((e) => !/Failed to fetch|abort/i.test(e)), []);
    console.log('app links browser regression passed');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
