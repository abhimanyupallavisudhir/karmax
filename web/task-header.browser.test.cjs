// Real browser regression: the task page header stays compact. Attempts sit on
// one line with the New attempt action, priority and tags share the byline, and
// the workflow name/version live on the Parameters tab only. Tasks open on
// Check-in, its toolbar actions share one size, and a draft attempt opens its form.
// SCREENSHOT_DIR=<dir> also writes screenshots. APP_SOURCE can test the baseline.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = __dirname;

const attempt = (n, extra = {}) => ({
  id: `a${n}`, projectId: 'p1', attemptNumber: n, workflow: 'software-dev', params: {}, tags: [],
  lastView: { taskId: `a${n}`, stage: 'do', status: 'waiting', waitingFor: { kind: 'human' }, state: {} }, ...extra,
});

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, colorScheme: process.env.COLOR_SCHEME || 'light' });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const records = [1, 2, 3].map((n) => ({ ...attempt(n), title: 'Make a video', num: 1, workflowVersion: '1.26.0', tags: n === 1 ? ['t1'] : [] }));
    records[1].params = { draft: true, prompt: 'Make a video' };
    records[1].lastView = { taskId: 'a2', stage: 'setup', status: 'waiting', state: { draft: true } };
    const view = {
      taskId: 'a1', num: 1, title: 'I want you to do an end-to-end complete pass on making a video', workflow: 'software-dev',
      workflowOptions: ['software-dev', 'goal'], workflowSwitchable: true,
      stage: 'do', status: 'waiting', waitingFor: { kind: 'human' }, state: {}, targetBranch: 'master',
      prs: [{ repo: 'videos', number: 1, url: 'https://github.com/o/videos/pull/1', state: 'open' },
        { repo: 'videos-wiki', number: 1, url: 'https://github.com/o/videos-wiki/pull/1', state: 'open' }],
      editableParams: [], agents: {}, messages: [], actions: [],
    };
    let group = { intentId: 'i1', principalAttemptId: 'a1', attempts: records };
    await page.route('**/*', async (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p.startsWith('/api/')) {
        let data = [];
        if (p === '/api/tasks/a1') data = view;
        else if (p === '/api/tasks/a2') data = { ...view, taskId: 'a2', stage: 'setup', status: 'waiting', state: { draft: true } };
        else if (p.endsWith('/attempts')) data = group;
        else if (p.endsWith('/sessions')) data = {};
        else if (p.includes('/defaults/')) data = { task: { inherited: {} } };
        else if (p.endsWith('/tasks')) data = records;
        else if (p.includes('explanation-settings')) data = { effective: { enabled: false } };
        else if (p.endsWith('/credentials')) data = { credentials: [], task: { own: {}, enabled: [] } };
        else if (p.endsWith('/accounts')) data = { logins: [] };
        return route.fulfill({ json: data });
      }
      const file = path.join(root, p === '/' ? 'index.html' : p);
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.abort();
      let body = fs.readFileSync(p === '/app.js' && process.env.APP_SOURCE || file, 'utf8');
      if (p === '/app.js') body = body.replace(/^boot\(\)\.catch\(.*$/m, 'window.headerTest = { S, openTask, setTaskTab }; installLinkRouter();');
      return route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    await page.goto('http://header.test/');
    await page.waitForFunction(() => window.headerTest);
    const open = (tab) => page.evaluate(async ({ records, tab }) => {
      const { S, openTask } = window.headerTest;
      document.querySelector('#app').innerHTML = '<main id="main" style="height:800px;display:flex;flex-direction:column"></main>';
      S.tasks = records; S.projects = [{ id: 'p1', slug: 'project', name: 'Project', organizationId: 'o1', config: {} }];
      S.projectId = 'p1'; S.organizationId = 'o1'; S.organizations = [{ id: 'o1', slug: 'test' }];
      S.tags = [{ id: 't1', name: 'video', kind: 'topic' }];
      S.meta = { workflows: [], hosted: true }; S.schema = [{ name: 'software-dev', params: [] }];
      S.selected = null; S.view = null;
      await openTask('a1', tab);
    }, { records, tab });
    const shot = async (name, selector = '.tp-head') => {
      if (!process.env.SCREENSHOT_DIR) return;
      fs.mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true });
      await page.locator(selector).screenshot({ path: path.join(process.env.SCREENSHOT_DIR, name) });
    };

    await open('overview');
    await page.waitForSelector('.attempt-card');
    await shot('task-header-attempts.png');
    const layout = await page.evaluate(() => {
      const top = (el) => Math.round(el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2);
      const head = document.querySelector('.tp-head');
      const meta = head.querySelector('.meta');
      return {
        headText: head.innerText,
        workflowInHead: !!head.querySelector('#tp-workflow-mode'),
        cardRows: new Set([...head.querySelectorAll('.attempt-card, #add-attempt')].map(top)).size,
        cardHeight: Math.max(...[...head.querySelectorAll('.attempt-card')].map((el) => el.getBoundingClientRect().height)),
        attemptChip: !!head.querySelector('.row1 .attempt-current'),
        metaRows: new Set([...meta.querySelectorAll('.pr-link, .org-priority, .tag-assignment, .org-add-tag')].map(top)).size,
        headHeight: head.getBoundingClientRect().height,
      };
    });
    assert.equal(layout.workflowInHead, false, 'workflow mode is not in the header');
    // The project the task belongs to heads the page, as a link back to its list.
    const crumb = page.locator('.tp-head .tp-crumbs a.tp-project');
    assert.equal(await crumb.innerText(), 'Project');
    assert.equal(await crumb.getAttribute('href'), '/test/project');
    assert.equal(await page.locator('.tp-crumbs .tp-parent').count(), 0, 'a top-level task has no parent crumb');
    const crumbAligned = await page.evaluate(() => {
      const x = (sel) => Math.round(document.querySelector(sel).getBoundingClientRect().left);
      return { crumb: x('.tp-crumbs .tp-project'), num: x('.tp-head .row1 .task-num') };
    });
    assert.ok(Math.abs(crumbAligned.crumb - crumbAligned.num) <= 2, `the project lines up with the task number (${JSON.stringify(crumbAligned)})`);
    assert.doesNotMatch(layout.headText, /Software dev|v1\.26\.0/, 'workflow name and version are not in the header');
    assert.doesNotMatch(layout.headText, /\d+ attempts/, 'no attempt-count heading');
    assert.doesNotMatch(layout.headText, /no tags|Shown in task list/, 'no filler text');
    assert.equal(layout.cardRows, 1, 'attempts and New attempt share one line');
    assert.ok(layout.cardHeight <= 32, `attempt cards are single-line (${layout.cardHeight}px)`);
    assert.equal(layout.attemptChip, false, 'the selected card marks the current attempt; no duplicate title chip');
    assert.equal(layout.metaRows, 1, 'PR links, priority and tags share one line');
    assert.ok(layout.headHeight <= 194, `header is compact (${layout.headHeight}px)`);

    // Without a pinned tab a task opens on Check-in, whose toolbar is one quiet row.
    await open(undefined);
    await page.waitForSelector('#fork-task-agent');
    assert.equal(await page.locator('.tp-tabs .tab.active').innerText(), 'Chat');
    await shot('task-checkin-toolbar.png', '.task-page .ck-pane-head');
    const tools = await page.evaluate(() => [...document.querySelectorAll('.ck-tools .btn, #local-checkout')]
      .map((el) => Math.round(el.getBoundingClientRect().height)));
    assert.ok(tools.length === 4 && tools.every((h) => h === 28), `toolbar actions share one size (${tools})`);

    // The crown still selects the principal attempt and the note is a tooltip.
    const crownTitle = await page.locator('.attempt-crown.principal').getAttribute('title');
    assert.match(crownTitle, /task list/i);

    // Parameters owns the workflow mode and its version.
    await open('parameters');
    await page.waitForSelector('#tp-workflow-mode');
    const params = await page.locator('.tp-content').innerText();
    assert.match(params, /v1\.26\.0/, 'workflow version is on the Parameters tab');
    assert.equal(await page.locator('.tp-head #tp-workflow-mode').count(), 0);

    // A draft attempt opens straight into its form.
    await open('overview');
    await page.locator('[data-attempt-select="a2"]').click();
    await page.waitForSelector('#tf-page');
    assert.match(await page.evaluate(() => location.pathname), /\/tasks\/a2$/);
    await page.evaluate(() => document.getElementById('overlay-root').replaceChildren());

    // One attempt: no attempt strip, but New attempt remains reachable.
    group = { intentId: 'i1', principalAttemptId: 'a1', attempts: [records[0]] };
    await open('overview');
    await page.waitForSelector('#add-attempt');
    await shot('task-header-single.png');
    assert.equal(await page.locator('.attempt-card').count(), 0, 'a single attempt shows no navigation strip');
    const single = await page.evaluate(() => document.querySelector('.tp-head').getBoundingClientRect().height);
    assert.ok(single <= 158, `single-attempt header is compact (${single}px)`);
    await crumb.click();
    await page.waitForFunction(() => location.pathname === '/test/project');

    assert.deepEqual(errors, []);
    console.log('task header browser regression passed');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
