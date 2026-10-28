// Real browser: approving a branch's own pull request (software-dev ≥1.30).
// Branches heads the details rail; a pull request waiting for its approval is a
// small box at the end of the conversation; Approve shows at once, before the
// server answers, and the pull request stays visibly alive (Approved, Landing,
// with what it waits for) until it lands, when the box goes.
// SCREENSHOT_DIR=<dir> also writes screenshots.
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
    const signals = [];
    const record = { id: 't1', projectId: 'p1', num: 102, title: 'Artefacts', workflow: 'software-dev', attemptNumber: 1, tags: [],
      params: { prompt: 'x' }, lastView: { taskId: 't1', stage: 'do', status: 'waiting' } };
    const view = {
      taskId: 't1', num: 102, title: record.title, workflow: 'software-dev', stage: 'do', status: 'waiting',
      waitingFor: { kind: 'subtask' }, state: {}, branch: 'tavya/t1', targetBranch: 'master', editableParams: [], agents: {},
      worldAvailable: true, actions: [{ name: 'followUp', enabled: true, args: ['text'] }],
      messages: [{ id: 'm0', role: 'user', text: 'Add the artefacts', ts: 1 }, { id: 'm1', role: 'agent', text: 'Opened the wiki pull request.', ts: 2 }],
      checkouts: [
        { name: 'pramana', branch: 'tavya/t1', base: 'master', target: 'master' },
        { name: 'pramana-wiki', branch: 'tavya/t1', base: 'main', target: 'main' },
      ],
      shipments: [{ checkout: 'pramana-wiki', childTaskId: 'pr-wiki', branch: 'tavya/pr-wiki', fromBranch: 'tavya/t1', head: 'h',
        target: 'main', state: 'open', requestId: 'r' }],
      subTaskSummaries: [{ id: 'pr-wiki', title: 'pramana-wiki: Artefacts', workflow: 'software-dev',
        lastView: { stage: 'review', status: 'waiting', waitingFor: { kind: 'human' } },
        pullRequest: { checkout: 'pramana-wiki', target: 'main', pr: { number: 86, url: 'https://github.com/o/pramana-wiki/pull/86', state: 'open' } } }],
    };
    let answer;
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      const p = url.pathname;
      if (p.startsWith('/api/')) {
        let data = [];
        if (p === '/api/tasks/t1') data = view;
        else if (p === '/api/tasks/pr-wiki/signal') {
          signals.push(JSON.parse(route.request().postData()));
          // The server is slow to answer: the page must not wait for it.
          await new Promise((resolve) => { answer = resolve; });
          data = {};
        } else if (p.endsWith('/attempts')) data = { intentId: 'i1', principalAttemptId: 't1', attempts: [record] };
        else if (p.endsWith('/sessions')) data = {};
        else if (p.endsWith('/widgets')) data = [];
        else if (p.includes('/defaults/')) data = { task: { inherited: {} } };
        else if (p.includes('explanation-settings')) data = { effective: { enabled: false } };
        else if (p.endsWith('/credentials')) data = { credentials: [], task: { own: {}, enabled: [] } };
        else if (p.endsWith('/accounts')) data = { logins: [] };
        return route.fulfill({ json: data });
      }
      const file = path.join(root, p === '/' ? 'index.html' : p);
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.abort();
      let body = fs.readFileSync(file, 'utf8');
      if (p === '/app.js') body = body.replace(/^boot\(\)\.catch\(.*$/m,
        'window.prTest = { S, openTask, patchSubTaskSummaryFromEvent, scheduleTaskPageRender }; installLinkRouter(); bindKeys();');
      return route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    await page.goto('http://pr.test/');
    await page.waitForFunction(() => window.prTest);
    await page.evaluate(async (record) => {
      const { S, openTask } = window.prTest;
      document.querySelector('#app').innerHTML = '<main id="main" style="height:860px;display:flex;flex-direction:column"></main>';
      S.tasks = [record]; S.projects = [{ id: 'p1', slug: 'pramana', name: 'pramana', organizationId: 'o1', config: {} }];
      S.projectId = 'p1'; S.organizationId = 'o1'; S.organizations = [{ id: 'o1', slug: 'test' }]; S.tags = [];
      S.meta = { workflows: [], hosted: true }; S.schema = [{ name: 'software-dev', params: [] }];
      await openTask('t1');
    }, record);
    const shot = async (name) => {
      if (!process.env.SCREENSHOT_DIR) return;
      fs.mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, name) });
    };
    // The child's own updates reach the page as they do from the socket.
    const childUpdate = (payload) => page.evaluate((payload) => {
      const { S, patchSubTaskSummaryFromEvent, scheduleTaskPageRender } = window.prTest;
      if (S.selected && patchSubTaskSummaryFromEvent({ type: 'view.updated', taskId: 'pr-wiki', payload })) scheduleTaskPageRender();
    }, payload);

    const box = page.locator('#ck-thread .pr-ask');
    const row = page.locator('#tp-rail .checkout-row', { hasText: 'pramana-wiki' });
    await box.waitFor();
    assert.match(await page.locator('#tp-rail .rail-inner > :first-child > .rail-h').innerText(), /^branches$/i, 'Branches heads the rail');
    assert.match(await box.innerText(), /pramana-wiki[\s\S]*→ main[\s\S]*#86[\s\S]*Approve/);
    assert.equal(await box.count(), 1, 'one box: the branch without a pull request of its own asks nothing');
    assert.match(await row.innerText(), /In review/);
    await shot('pr-approval-1-waiting.png');

    await box.getByRole('button', { name: 'Approve' }).click();
    // Approved on screen while the server has not answered yet.
    await page.waitForFunction(() => /Approved/.test(document.querySelector('#ck-thread .pr-ask')?.textContent || ''), null, { timeout: 1000 });
    assert.match(await row.innerText(), /Approved/);
    assert.equal(await page.locator('#tp-rail .checkout-row .chip.live', { hasText: 'Approved' }).count(), 1, 'it pulses while on its way');
    assert.equal(await page.locator('[data-approve-pr]').count(), 0, 'no second Approve anywhere');
    assert.deepEqual(signals, [{ signal: 'confirm' }]);
    await shot('pr-approval-2-approved.png');
    answer();

    // Its record moves on: landing, then landed.
    await childUpdate({ stage: 'merge', status: 'waiting', waitingFor: 'merge', waitingDetail: 'Waiting for CI' });
    await page.waitForFunction(() => /Landing/.test(document.querySelector('#ck-thread .pr-ask')?.textContent || ''));
    assert.equal(await row.locator('.chip.live').getAttribute('title'), 'Waiting for CI');
    await shot('pr-approval-3-landing.png');
    await childUpdate({ stage: 'done', status: 'done' });
    await box.waitFor({ state: 'detached' });
    assert.match(await row.innerText(), /✓[\s\S]*Landed/);
    await shot('pr-approval-4-landed.png');

    assert.deepEqual(errors, []);
    console.log('pull-request approval browser test: ok');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exit(1); });
