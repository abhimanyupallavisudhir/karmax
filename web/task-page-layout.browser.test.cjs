// Real browser regression: a task is ONE page. The conversation (closed by its
// review) sits beside a details rail; Parameters is the only other view, and
// every fact shows once — no Overview or Approval Requests tabs repeating the
// stage, the review or the requests. On a narrow window the rail floats over
// the conversation only when asked for, and survives background repaints.
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
    const requests = [];
    const record = { id: 't1', projectId: 'p1', num: 4, title: 'Dark-mode toggle', workflow: 'software-dev', attemptNumber: 1, tags: [],
      params: { prompt: 'Add it' }, subTasks: ['t2'], lastView: { taskId: 't1', stage: 'review', status: 'waiting' } };
    const child = { id: 't2', projectId: 'p1', num: 5, title: 'Write the tests', workflow: 'software-dev', tags: [], parentTaskId: 't1',
      params: {}, lastView: { taskId: 't2', stage: 'do', status: 'active' } };
    const view = {
      taskId: 't1', num: 4, title: record.title, workflow: 'software-dev', stage: 'review', status: 'waiting',
      waitingFor: { kind: 'human' }, state: {}, branch: 'tavya/t1', targetBranch: 'main', subTasks: ['t2'],
      reviewInfo: { caption: 'Toggle lives in Settings → Appearance.', actions: [{ kind: 'run', label: 'Run tests', command: 'npm test' }] },
      notes: 'Ask design', editableParams: [], agents: {}, worldAvailable: true,
      actions: [{ name: 'confirm', label: 'Confirm PR', enabled: true }, { name: 'followUp', enabled: true, args: ['text'] }],
      messages: [{ id: 'm0', role: 'user', text: 'Add it', ts: 1 }, { id: 'm1', role: 'agent', text: 'Done — see the review.', ts: 2 }],
    };
    let notes = null;
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      const p = url.pathname;
      if (p.startsWith('/api/')) {
        requests.push(p);
        let data = [];
        if (p === '/api/tasks/t1') data = view;
        else if (p === '/api/tasks/t1/notes') { notes = JSON.parse(route.request().postData()).notes; data = {}; }
        else if (p.endsWith('/attempts')) data = { intentId: 'i1', principalAttemptId: 't1', attempts: [record] };
        else if (p.endsWith('/sessions')) data = {};
        else if (p.endsWith('/widgets')) data = [{ title: 'Changed files', widgets: [{ type: 'list', data: ['src/theme.js'] }] }];
        else if (p.includes('/defaults/')) data = { task: { inherited: {} } };
        else if (p.includes('explanation-settings')) data = { effective: { enabled: false } };
        else if (p.endsWith('/credentials')) data = { credentials: [], task: { own: {}, enabled: [] } };
        else if (p.endsWith('/accounts')) data = { logins: [] };
        return route.fulfill({ json: data });
      }
      const file = path.join(root, p === '/' ? 'index.html' : p);
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.abort();
      let body = fs.readFileSync(file, 'utf8');
      if (p === '/app.js') body = body.replace(/^boot\(\)\.catch\(.*$/m, 'window.layoutTest = { S, openTask, renderTaskPage }; installLinkRouter();');
      return route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    await page.goto('http://layout.test/');
    await page.waitForFunction(() => window.layoutTest);
    const open = (tab) => page.evaluate(async ({ record, child, tab }) => {
      const { S, openTask } = window.layoutTest;
      document.querySelector('#app').innerHTML = '<main id="main" style="height:860px;display:flex;flex-direction:column"></main>';
      S.tasks = [record, child]; S.projects = [{ id: 'p1', slug: 'project', name: 'Project', organizationId: 'o1', config: {} }];
      S.projectId = 'p1'; S.organizationId = 'o1'; S.organizations = [{ id: 'o1', slug: 'test' }]; S.tags = [];
      S.meta = { workflows: [], hosted: true }; S.schema = [{ name: 'software-dev', params: [] }];
      S.selected = null; S.view = null; S.taskTab = null;
      await openTask('t1', tab);
    }, { record, child, tab });
    const shot = async (name) => {
      if (!process.env.SCREENSHOT_DIR) return;
      fs.mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, name) });
    };

    await open(undefined);
    await page.waitForSelector('#tp-rail .subtask-row');
    await page.waitForSelector('.review-info');
    await shot('task-page.png');
    assert.deepEqual(await page.locator('.tp-views .tab').allInnerTexts(), ['Chat', 'Parameters'], 'two views, no Overview or Approval Requests');
    assert.equal(await page.locator('.tp-views .tab.active').innerText(), 'Chat', 'a task opens on its conversation');
    const text = await page.locator('.task-page').innerText();
    const count = (needle) => text.split(needle).length - 1;
    assert.equal(count('Toggle lives in Settings'), 1, 'the review shows once, closing the conversation');
    assert.equal(await page.locator('.review-info').evaluate((el) => !el.nextElementSibling), true, 'nothing follows the review in the thread');
    assert.equal(await page.locator('.pipeline-lg').count(), 0, 'no second, larger pipeline');
    assert.equal(await page.locator('.tp-stage .pipeline').count(), 1, 'the stage carries its pipeline');
    for (const selector of ['.subtask-row[data-open="t2"]', '#task-notes', '.org-priority', '#ck-term-item', '#local-checkout', '#approval-history-open'])
      assert.equal(await page.locator(`#tp-rail ${selector}`).count(), 1, `${selector} is in the details rail`);
    assert.match(await page.locator('#tp-rail').innerText(), /src\/theme\.js/, 'workflow widgets are in the rail');
    assert.equal(await page.locator('.task-page').evaluate((el) => !el.textContent.includes('Nothing to do here')), true);

    // Approval requests load only when their history is opened.
    assert.equal(requests.filter((p) => p === '/api/permission-requests').length, 0, 'opening a task does not load its approval history');
    await page.locator('#approval-history-open').click();
    await page.locator('#task-approval-history .approval-list').waitFor();
    assert.equal(requests.filter((p) => p === '/api/permission-requests').length, 1, 'the history loads its requests');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#approval-history').count(), 0, 'Escape closes it');

    // Notes save when focus leaves them.
    await page.locator('#task-notes').fill('Ask design about the icon');
    await page.locator('.tp-head h2').click();
    await page.waitForTimeout(100);
    assert.equal(notes, 'Ask design about the icon', 'notes save on blur');

    // The rail stays when the view changes; a rail agent returns to the chat.
    await page.locator('.tp-views [data-tasktab="parameters"]').click();
    await page.waitForSelector('#tp-params, #edit-draft-params');
    assert.equal(await page.locator('#tp-rail #ck-term-item').count(), 1, 'the rail beside Parameters too');
    await page.locator('#tp-rail [data-checkin="terminal"]').click();
    await page.waitForSelector('.tp-views .tab.active[data-tasktab="checkin"]');
    await page.waitForSelector('#term-open');

    // A former tab's link opens the conversation.
    await open('overview');
    await page.waitForSelector('.review-info');
    assert.equal(await page.locator('.tp-views .tab.active').innerText(), 'Chat');

    // Closing the rail on a wide window sticks across repaints.
    await page.locator('#tp-rail-toggle').click();
    assert.equal(await page.locator('#tp-rail').isVisible(), false);
    await page.evaluate(() => window.layoutTest.renderTaskPage());
    assert.equal(await page.locator('#tp-rail').isVisible(), false, 'a repaint keeps it closed');
    await page.locator('#tp-rail-toggle').click();
    assert.equal(await page.locator('#tp-rail').isVisible(), true);

    // A narrow window: the rail floats over the conversation only on request.
    await page.setViewportSize({ width: 390, height: 844 });
    await open(undefined);
    await page.waitForSelector('.review-info');
    assert.equal(await page.locator('#tp-rail').isVisible(), false, 'a phone opens on the conversation alone');
    await page.locator('#tp-rail-toggle').click();
    assert.equal(await page.locator('#tp-rail').isVisible(), true);
    await shot('task-page-mobile-details.png');
    await page.evaluate(() => window.layoutTest.renderTaskPage());
    assert.equal(await page.locator('#tp-rail').isVisible(), true, 'a background repaint keeps the open rail');
    await page.locator('.tp-col').dispatchEvent('pointerdown');
    assert.equal(await page.locator('#tp-rail').isVisible(), false, 'touching the conversation puts it away');
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.evaluate(() => window.layoutTest.renderTaskPage());
    assert.equal(await page.locator('#tp-rail').isVisible(), true, 'a narrow window never closes the wide one’s rail');

    assert.deepEqual(errors, []);
    console.log('task page layout browser regression passed');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
