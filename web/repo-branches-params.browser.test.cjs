// Real browser regression: a running task that uses different branches per
// repository lists them, read-only, under Base/Target in its Parameters tab;
// a task without them shows no such row.
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
    const repoBranches = { '/src/app': { base: 'main', target: 'main' }, 'git@github.com:acme/lib.git': { base: 'master', target: 'master' } };
    const records = {
      mixed: { id: 'mixed', projectId: 'p1', workflow: 'software-dev', params: { prompt: 'x', base: 'main', target: 'main', repoBranches } },
      common: { id: 'common', projectId: 'p1', workflow: 'software-dev', params: { prompt: 'x', base: 'main', target: 'main' } },
    };
    const view = (id) => ({ taskId: id, title: id, workflow: 'software-dev', stage: 'do', status: 'active', base: 'main', targetBranch: 'main',
      editableParams: ['target'], agents: {}, messages: [], actions: [] });
    await page.route('**/*', async route => {
      const p = new URL(route.request().url()).pathname;
      if (p.startsWith('/api/')) {
        let data = [];
        const task = /^\/api\/tasks\/([^/]+)$/.exec(p);
        if (task) data = view(task[1]);
        else if (p.endsWith('/attempts')) data = null;
        else if (p.endsWith('/sessions')) data = {};
        else if (p.includes('/defaults/')) data = { task: { inherited: {} } };
        else if (p.endsWith('/tasks')) data = Object.values(records);
        else if (p.includes('explanation-settings')) data = { effective: { enabled: false } };
        return route.fulfill({ json: data });
      }
      let file = path.join(root, p === '/' ? 'index.html' : p);
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.abort();
      let body = fs.readFileSync(p === '/app.js' && process.env.APP_SOURCE || file, 'utf8');
      if (p === '/app.js') body = body.replace(/^boot\(\)\.catch\(.*$/m, 'window.repoBranchesTest = { S, openTask };');
      return route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    await page.goto('http://repo-branches.test/');
    await page.waitForFunction(() => window.repoBranchesTest);
    const open = (id) => page.evaluate(async ({ records, id }) => {
      const { S, openTask } = window.repoBranchesTest;
      document.querySelector('#app').innerHTML = '<main id="main" style="height:600px"></main>';
      S.tasks = Object.values(records); S.projects = [{ id: 'p1', slug: 'project', name: 'Project', organizationId: 'o1', config: {} }];
      S.projectId = 'p1'; S.organizationId = 'o1'; S.organizations = [{ id: 'o1', slug: 'test' }];
      S.meta = { workflows: [] };
      S.schema = [{ name: 'software-dev', params: [
        { name: 'base', label: 'Base (branch-from) branch', type: 'branch', scopes: ['task', 'project', 'global'] },
        { name: 'target', label: 'Target (merge-to) branch', type: 'branch', scopes: ['task', 'project', 'global'], mutable: 'untilUsed' },
        { name: 'repoBranches', label: 'Different branches per repo', type: 'repoBranches', scopes: ['task', 'project'] },
      ] }];
      await openTask(id, 'parameters');
    }, { records, id });

    await open('mixed');
    await page.locator('#tp-params .branch-pair').waitFor();
    assert.deepEqual(await page.locator('#tp-params .rb-frozen > div').allInnerTexts(),
      ['app main → main', 'acme/lib master → master']);
    assert.equal(await page.locator('#tp-params [data-row="repoBranches"] .pf-lock').count(), 1);

    await open('common');
    await page.locator('#tp-params .branch-pair').waitFor();
    assert.equal(await page.locator('#tp-params [data-row="repoBranches"]').count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
