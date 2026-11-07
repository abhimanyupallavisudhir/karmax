// Real browser regression: the browser tab names the console page on screen —
// the task, the project, the organization view — not just the site, and leads
// with the bell's count while something waits on you.
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
    page.on('pageerror', (e) => { errors.push(e.message); if (process.env.DEBUG) console.error(e.stack); });
    const task = {
      id: 't7', num: 7, projectId: 'p1', title: 'Fix the login page', workflow: 'software-dev', params: {}, tags: [],
      lastView: { taskId: 't7', stage: 'do', status: 'running', state: {} },
    };
    const view = { taskId: 't7', num: 7, title: 'Fix the login page', workflow: 'software-dev', stage: 'do', status: 'running',
      state: {}, editableParams: [], agents: {}, messages: [], actions: [] };
    await page.route('**/*', async (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p.startsWith('/api/')) {
        let data = [];
        if (p === '/api/tasks/t7') data = view;
        else if (p.endsWith('/attempts')) data = { intentId: 'i7', principalAttemptId: 't7', attempts: [task] };
        else if (p.endsWith('/sessions')) data = {};
        else if (p.includes('/defaults/')) data = { task: { inherited: {} } };
        else if (p.endsWith('/tasks')) data = [task];
        else if (p.includes('explanation-settings')) data = { effective: { enabled: false } };
        else if (p.endsWith('/credentials')) data = { credentials: [], task: { own: {}, enabled: [] } };
        else if (p.endsWith('/accounts')) data = { logins: [] };
        return route.fulfill({ json: data });
      }
      const file = path.join(root, p === '/' ? 'index.html' : p);
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.abort();
      let body = fs.readFileSync(p === '/app.js' && process.env.APP_SOURCE || file, 'utf8');
      if (p === '/app.js') body = body.replace(/^boot\(\)\.catch\(.*$/m,
        'window.titleTest = { S, openTask, closeTaskDom, renderMain, updateBell, renderRouteLoadingPage, openTaskForm, syncDocumentTitle }; installLinkRouter();');
      return route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    await page.goto('http://title.test/');
    await page.waitForFunction(() => window.titleTest);
    await page.evaluate((task) => {
      const { S } = window.titleTest;
      document.querySelector('#app').innerHTML = '<main id="main" style="height:800px;display:flex;flex-direction:column"></main><div id="overlay-root"></div>';
      S.tasks = [task]; S.projects = [{ id: 'p1', slug: 'karmax', name: 'karmax', organizationId: 'o1', config: {} }];
      S.projectId = 'p1'; S.organizationId = 'o1'; S.organizations = [{ id: 'o1', slug: 'acme', name: 'Acme' }];
      S.meta = { workflows: [], hosted: true, siteName: 'tavya' }; S.schema = [{ name: 'software-dev', params: [] }];
      S.inbox = []; S.selected = null; S.view = null;
    }, task);
    const titleOf = (setup) => page.evaluate((setup) => {
      const { S, renderMain, closeTaskDom } = window.titleTest;
      closeTaskDom();
      Object.assign(S, setup);
      renderMain();
      return document.title;
    }, setup);
    // Views whose hydration needs far more of the API than this stub serves: name them without painting.
    const titleOnly = (setup) => page.evaluate((setup) => {
      Object.assign(window.titleTest.S, setup);
      window.titleTest.syncDocumentTitle();
      return document.title;
    }, setup);

    // Each page names itself, most specific part first, the site last.
    assert.equal(await titleOf({ tab: 'tasks' }), 'karmax · tavya', 'a project list');
    assert.equal(await titleOf({ tab: 'queue' }), 'Queues · karmax · tavya');
    assert.equal(await titleOf({ tab: 'wiki' }), 'Wiki · karmax · tavya');
    assert.equal(await titleOf({ tab: 'settings' }), 'Settings · karmax · tavya', 'project settings');
    // Files names the open file, as an editor tab would.
    assert.equal(await titleOnly({ tab: 'files', filesPath: 'src/gateway/app.ts' }), 'app.ts · karmax · tavya', 'a file');
    assert.equal(await titleOnly({ filesPath: '' }), 'Files · karmax · tavya', 'the Files root');
    assert.equal(await titleOf({ tab: 'home' }), 'Acme · tavya', 'the organization home');
    assert.equal(await titleOnly({ tab: 'insights' }), 'Insights · Acme · tavya');
    assert.equal(await titleOnly({ tab: 'organization' }), 'Settings · Acme · tavya', 'organization settings');
    assert.equal(await titleOf({ tab: 'inbox' }), 'Inbox · tavya');
    assert.equal(await titleOnly({ tab: 'profile' }), 'Profile · tavya');

    // A task page names the task, then where it lives.
    await page.evaluate(() => window.titleTest.openTask('t7'));
    await page.waitForSelector('#tp-body');
    assert.equal(await page.title(), 'Fix the login page · karmax #7 · tavya', 'a task page');
    // …and follows a rename.
    await page.evaluate(() => { const { S, renderMain } = window.titleTest; S.view = { ...S.view, title: 'Fix sign-in' }; renderMain(); });
    assert.equal(await page.title(), 'Fix sign-in · karmax #7 · tavya', 'a renamed task');

    // Something waiting on you shows as the bell's count, in front.
    await page.evaluate(() => {
      const { S, updateBell } = window.titleTest;
      S.inbox = [{ id: 'n1', unread: true, kind: 'ask', taskId: 'other' }, { id: 'n2', unread: true, kind: 'approval' },
        { id: 'n3', unread: true, kind: 'update' }];
      updateBell();
    });
    assert.equal(await page.title(), '(2) Fix sign-in · karmax #7 · tavya', 'the unread count leads; routine updates do not count');
    await page.evaluate(() => { const { S, updateBell } = window.titleTest; S.inbox = []; updateBell(); });
    assert.equal(await page.title(), 'Fix sign-in · karmax #7 · tavya', 'the count goes once read');

    // A route that is still loading names what it opens.
    await page.evaluate(() => { window.titleTest.closeTaskDom(); window.titleTest.renderRouteLoadingPage('Task #9', 'Loading task…'); });
    assert.equal(await page.title(), 'Task #9 · tavya');

    // The new-task page, and leaving it.
    await titleOf({ tab: 'tasks' });
    await page.evaluate(() => window.titleTest.openTaskForm('software-dev'));
    await page.waitForSelector('#tf-page');
    assert.equal(await page.title(), 'New task · tavya', 'the new-task page');
    await page.locator('#tf-close').click();
    assert.equal(await page.title(), 'karmax · tavya', 'closing it names the page beneath');

    // The installation's own name, not "tavya".
    assert.equal(await titleOf({ tab: 'tasks', meta: { workflows: [], hosted: false, siteName: 'Acme Agents' } }), 'karmax · Acme Agents');

    assert.deepEqual(errors, []);
    console.log('tab title browser regression passed');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
