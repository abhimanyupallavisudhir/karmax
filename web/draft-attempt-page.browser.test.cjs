// Real browser regression: a draft attempt's page IS its draft form. However the
// draft is reached — attempt card, keyboard, permalink, New attempt — the form
// opens directly, and its "Edit draft" bar carries an attempt switcher when the
// task has other attempts. SCREENSHOT_DIR=<dir> also writes screenshots.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = __dirname;

const attempt = (n, extra = {}) => ({
  id: `a${n}`, projectId: 'p1', attemptNumber: n, workflow: 'software-dev', title: 'Make a video', num: 1,
  params: {}, tags: [], lastView: { taskId: `a${n}`, stage: 'do', status: 'waiting', waitingFor: { kind: 'human' }, state: {} },
  ...extra,
});
const draftOf = (n) => attempt(n, {
  params: { draft: true, prompt: `Draft ${n}` },
  lastView: { taskId: `a${n}`, stage: 'setup', status: 'waiting', state: { draft: true } },
});

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    let records = [attempt(1), draftOf(2), attempt(3)];
    let slowListOnce = false;
    let group = () => ({ intentId: 'i1', principalAttemptId: 'a1', attempts: records });
    const created = [];
    const viewOf = (id) => {
      const r = records.find((t) => t.id === id);
      return r?.params.draft
        ? { taskId: id, title: r.title, workflow: 'software-dev', stage: 'setup', status: 'waiting', state: { draft: true }, messages: [], actions: [] }
        : { taskId: id, num: 1, title: 'Make a video', workflow: 'software-dev', stage: 'do', status: 'waiting',
          waitingFor: { kind: 'human' }, state: {}, editableParams: [], agents: {}, messages: [], actions: [] };
    };
    await page.route('**/*', async (route) => {
      const req = route.request();
      const p = new URL(req.url()).pathname;
      if (p.startsWith('/api/')) {
        let data = [];
        const task = p.match(/^\/api\/tasks\/([^/]+)$/);
        if (task) data = viewOf(task[1]);
        else if (p.endsWith('/attempts') && req.method() === 'POST') {
          const next = draftOf(records.length + 1);
          records = [...records, next];
          created.push(next.id);
          data = next;
        } else if (p.endsWith('/queue') && req.method() === 'POST') {
          const id = p.split('/')[3];
          records = records.map((r) => (r.id === id ? { ...r, params: { prompt: r.params.prompt } } : r));
          // A slow task list after Run, as on a loaded CI runner: the page must
          // not show the draft it was, under the form, while the list loads.
          slowListOnce = true;
          data = {};
        } else if (p.endsWith('/attempts')) data = group();
        else if (p.endsWith('/sessions')) data = {};
        else if (p.includes('/defaults/')) data = { task: { inherited: {} } };
        else if (p.endsWith('/tasks')) {
          if (slowListOnce) { slowListOnce = false; await new Promise((resolve) => setTimeout(resolve, 400)); }
          data = records.filter((r) => r.id === 'a1');
        }
        else if (p.includes('explanation-settings')) data = { effective: { enabled: false } };
        else if (p.endsWith('/credentials')) data = { credentials: [], task: { own: {}, enabled: [] } };
        else if (p.endsWith('/accounts')) data = { logins: [] };
        else if (req.method() !== 'GET') data = {};
        return route.fulfill({ json: data });
      }
      const file = path.join(root, p === '/' ? 'index.html' : p);
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.abort();
      let body = fs.readFileSync(file, 'utf8');
      if (p === '/app.js') body = body.replace(/^boot\(\)\.catch\(.*$/m,
        'window.draftTest = { S, go, cycleAttempt, installLinkRouter, projectBase }; installLinkRouter();');
      return route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    await page.goto('http://draft.test/');
    await page.waitForFunction(() => window.draftTest);
    await page.evaluate(() => {
      const { S } = window.draftTest;
      document.querySelector('#app').innerHTML = '<main id="main" style="height:800px;display:flex;flex-direction:column"></main>';
      S.projects = [{ id: 'p1', slug: 'project', name: 'Project', organizationId: 'o1', config: {} }];
      S.projectId = 'p1'; S.organizationId = 'o1'; S.organizations = [{ id: 'o1', slug: 'test' }];
      S.tags = []; S.orgProjectId = 'p1';
      S.meta = { workflows: [], hosted: true }; S.schema = [{ name: 'software-dev', params: [] }];
    });
    const go = (href) => page.evaluate((href) => window.draftTest.go(href), href);
    const task = (id) => `/test/project/tasks/${id}`;
    const switcher = () => page.evaluate(() => [...document.querySelectorAll('#tf-page .tf-head [data-attempt-select]')]
      .map((el) => ({ id: el.dataset.attemptSelect, current: el.getAttribute('aria-current') === 'true', link: el.tagName === 'A' })));
    const shot = async (name) => {
      if (!process.env.SCREENSHOT_DIR) return;
      fs.mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true });
      await page.waitForTimeout(250); // let the page slide-in settle
      await page.locator('#tf-page .tf-head').screenshot({ path: path.join(process.env.SCREENSHOT_DIR, name) });
    };
    const formFor = async (id) => {
      await page.waitForSelector('#tf-page .tf-head h2');
      await page.waitForFunction((id) => document.querySelector(`#tf-page .tf-head [aria-current="true"][data-attempt-select="${id}"]`), id);
    };

    // A permalink to a draft attempt opens its form, not a Parameters stub.
    await go(task('a2'));
    await formFor('a2');
    assert.equal(await page.locator('#tf-page .tf-head h2').innerText(), 'Edit draft');
    assert.ok(await page.evaluate(() => document.elementFromPoint(700, 450)?.closest('#tf-page')),
      'the form is what shows — no Parameters tab or Edit parameters detour');
    assert.deepEqual(await switcher(), [
      { id: 'a1', current: false, link: true },
      { id: 'a2', current: true, link: false },
      { id: 'a3', current: false, link: true },
    ], 'the Edit draft bar switches between every attempt; the current one is marked, not a link');
    const head = await page.evaluate(() => {
      const bar = document.querySelector('#tf-page .tf-head');
      const cards = [...bar.querySelectorAll('.attempt-card')];
      return {
        rows: new Set(cards.map((el) => Math.round(el.getBoundingClientRect().top))).size,
        barHeight: bar.getBoundingClientRect().height,
        crowns: bar.querySelectorAll('.attempt-crown').length,
      };
    });
    assert.equal(head.rows, 1, 'switcher stays on one line');
    assert.ok(head.barHeight <= 64, `Edit draft bar stays compact (${head.barHeight}px)`);
    assert.equal(head.crowns, 0, 'principal selection stays on the task page');
    await shot('draft-form-switcher.png');

    // Switching to a running attempt from the form leaves the form for its page.
    await page.locator('#tf-page .tf-head [data-attempt-select="a1"]').click();
    await page.waitForFunction(() => !document.getElementById('tf-page') && document.querySelector('.task-page .attempt-card.selected[data-attempt-select="a1"]'));
    assert.match(await page.evaluate(() => location.pathname), /\/tasks\/a1$/);

    // Keyboard attempt cycling lands in the draft form too.
    await page.evaluate(() => window.draftTest.cycleAttempt(1));
    await formFor('a2');
    // …and from the form it moves on to the next attempt.
    await page.evaluate(() => window.draftTest.cycleAttempt(1));
    await page.waitForFunction(() => !document.getElementById('tf-page') && document.querySelector('.task-page .attempt-card.selected[data-attempt-select="a3"]'));

    // Clicking the draft's card on a task page opens the form directly.
    await page.locator('.task-page [data-attempt-select="a2"]').click();
    await formFor('a2');

    // Back leaves the draft's page rather than revealing an empty stub under it.
    await page.locator('#tf-close').click();
    await page.waitForFunction(() => !/\/tasks\//.test(location.pathname) && !document.querySelector('.task-page'));
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#tf-page').count(), 0, 'a late load does not reopen the draft just left');

    // New attempt opens the new draft's form, whose switcher already lists it.
    await go(task('a1'));
    await page.waitForSelector('.task-page #add-attempt');
    await page.locator('#add-attempt').click();
    await formFor('a4');
    assert.deepEqual((await switcher()).map((a) => a.id), ['a1', 'a2', 'a3', 'a4']);

    // Running the draft from its page reveals its live task page in place.
    await page.waitForFunction(() => !document.querySelector('#tf-page[aria-busy]'));
    await page.locator('#tf-queue').click();
    await page.waitForFunction(() => !document.getElementById('tf-page')
      && document.querySelector('.task-page .attempt-card.selected[data-attempt-select="a4"]'));
    assert.match(await page.evaluate(() => location.pathname), /\/tasks\/a4$/);
    assert.equal(await page.locator('.task-page #edit-draft-params').count(), 0, 'a started attempt is no longer a draft page');

    // Saving a draft from its page leaves it, like Back.
    await go(task('a2'));
    await formFor('a2');
    await page.locator('#tf-draft').click();
    await page.waitForFunction(() => !document.getElementById('tf-page') && !/\/tasks\//.test(location.pathname));

    // A lone draft has nothing to switch to.
    records = [draftOf(1)];
    await go(task('a1'));
    await page.waitForSelector('#tf-page .tf-head h2');
    await page.waitForFunction(() => !document.querySelector('#tf-page[aria-busy]'));
    assert.equal(await page.locator('#tf-page .tf-head [data-attempt-select]').count(), 0, 'no switcher without other attempts');

    assert.deepEqual(errors, []);
    console.log('draft attempt page browser regression passed');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
