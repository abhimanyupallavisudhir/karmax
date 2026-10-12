// Real browser regression: a task with no workflow execution yet (waiting for
// its dependency or schedule) has no view — GET /api/tasks/:id answers null.
// Opening it must never throw ("Cannot read properties of null"): a task waiting
// for its trigger opens as its editable form, like a draft, and any other task
// without a view says it has not started. Background refreshes stay quiet too.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = __dirname;

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const armed = { id: 't1', projectId: 'p1', num: 4, title: 'Release notes', workflow: 'software-dev', attemptNumber: 1, tags: [],
      params: { prompt: 'Write them', triggers: [{ kind: 'dependency', tasks: ['t0'] }], triggerState: 'armed' } };
    const pending = { id: 't2', projectId: 'p1', num: 5, title: 'Starting soon', workflow: 'software-dev', attemptNumber: 1, tags: [], params: { prompt: 'Go' } };
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      const p = url.pathname;
      if (p.startsWith('/api/')) {
        let data = [];
        if (p === '/api/tasks/t1' || p === '/api/tasks/t2') return route.fulfill({ body: 'null', contentType: 'application/json' });
        else if (p.endsWith('/attempts')) return route.fulfill({ body: 'null', contentType: 'application/json' });
        else if (p.endsWith('/sessions')) data = {};
        else if (p.includes('/defaults/')) data = { task: { inherited: {} } };
        else if (p.includes('explanation-settings')) data = { effective: { enabled: false } };
        else if (p.endsWith('/credentials')) data = { credentials: [], task: { own: {}, enabled: [] } };
        else if (p.endsWith('/accounts')) data = { logins: [] };
        return route.fulfill({ json: data });
      }
      const file = path.join(root, p === '/' ? 'index.html' : p);
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.abort();
      let body = fs.readFileSync(file, 'utf8');
      if (p === '/app.js') body = body.replace(/^boot\(\)\.catch\(.*$/m, 'window.t = { S, openTask, refreshTask, toast: (...a) => toast(...a) }; window.toasts = []; toast = (m) => window.toasts.push(m); installLinkRouter();');
      return route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    await page.goto('http://not-started.test/');
    await page.waitForFunction(() => window.t);
    const open = (id) => page.evaluate(async ({ armed, pending, id }) => {
      const { S, openTask } = window.t;
      document.querySelector('#app').innerHTML = '<main id="main" style="height:860px;display:flex;flex-direction:column"></main>';
      document.querySelector('#overlay-root').innerHTML = ''; // the previous task's form page
      S.tasks = [armed, pending]; S.projects = [{ id: 'p1', slug: 'project', name: 'Project', organizationId: 'o1', config: {} }];
      S.projectId = 'p1'; S.organizationId = 'o1'; S.organizations = [{ id: 'o1', slug: 'test' }]; S.tags = [];
      S.meta = { workflows: [] }; S.schema = [{ name: 'software-dev', params: [{ name: 'prompt', type: 'text', label: 'Prompt', scopes: ['task'] }] }];
      S.selected = null; S.view = null; S.taskTab = null;
      history.replaceState({}, '', `/test/project/tasks/${id === 't1' ? 4 : 5}`);
      await openTask(id);
      await window.t.refreshTask();
    }, { armed, pending, id });

    await open('t1');
    await page.locator('#tf-page').waitFor();
    assert.deepEqual(await page.evaluate(() => window.toasts), [], 'no error toast');

    await open('t2');
    await page.getByText('Not started yet').waitFor();
    assert.deepEqual(await page.evaluate(() => window.toasts), [], 'no error toast');
    assert.deepEqual(errors, []);
    console.log('task not started browser regression passed');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
