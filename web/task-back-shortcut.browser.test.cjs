// Real browser regression: `u` (back to the list) works on a task page wherever
// focus was left by the page itself — after sending a follow-up, or on a
// checkbox — and is still an ordinary letter in a text field.
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
    const record = { id: 't1', projectId: 'p1', num: 4, title: 'Dark-mode toggle', workflow: 'software-dev', attemptNumber: 1, tags: [],
      params: { prompt: 'Add it' }, lastView: { taskId: 't1', stage: 'do', status: 'waiting' } };
    const view = {
      taskId: 't1', num: 4, title: record.title, workflow: 'software-dev', stage: 'do', status: 'waiting',
      waitingFor: { kind: 'human' }, state: {}, branch: 'tavya/t1', targetBranch: 'main', subTasks: [],
      notes: '', editableParams: [], agents: {}, worldAvailable: true,
      actions: [{ name: 'followUp', enabled: true, args: ['text'] }],
      messages: [{ id: 'm0', role: 'user', text: 'Add it', ts: 1 }, { id: 'm1', role: 'agent', text: 'Which icon?', ts: 2 }],
    };
    const signals = [];
    await page.route('**/*', async (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p.startsWith('/api/')) {
        let data = [];
        if (p === '/api/tasks/t1') data = view;
        else if (p === '/api/tasks/t1/signal') { signals.push(JSON.parse(route.request().postData())); data = {}; }
        else if (p.endsWith('/attempts')) data = { intentId: 'i1', principalAttemptId: 't1', attempts: [record] };
        else if (p.endsWith('/sessions')) data = {};
        else if (p.includes('/defaults/')) data = { task: { inherited: {} } };
        else if (p.includes('explanation-settings')) data = { effective: { enabled: false } };
        return route.fulfill({ json: data });
      }
      const file = path.join(root, p === '/' ? 'index.html' : p);
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.abort();
      let body = fs.readFileSync(file, 'utf8');
      if (p === '/app.js') body = body.replace(/^boot\(\)\.catch\(.*$/m, 'window.backTest = { S, openTask }; installLinkRouter(); bindKeys();');
      return route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    await page.goto('http://back.test/');
    await page.waitForFunction(() => window.backTest);
    // Navigations are recorded, not performed: `u` leaving the page = one push.
    await page.evaluate(() => { window.pushes = []; history.pushState = (state, title, url) => window.pushes.push(url); });
    const open = async () => {
      await page.evaluate(async (record) => {
        const { S, openTask } = window.backTest;
        window.pushes = [];
        document.querySelector('#app').innerHTML = '<main id="main" style="height:860px;display:flex;flex-direction:column"></main>';
        S.tasks = [record]; S.projects = [{ id: 'p1', slug: 'project', name: 'Project', organizationId: 'o1', config: {} }];
        S.projectId = 'p1'; S.organizationId = 'o1'; S.organizations = [{ id: 'o1', slug: 'test' }]; S.tags = [];
        S.meta = { workflows: [], hosted: true }; S.schema = [{ name: 'software-dev', params: [] }];
        S.selected = null; S.view = null; S.taskTab = null; S.returnRoute = '/test/project';
        await openTask('t1');
      }, record);
      await page.waitForSelector('.followup-input');
    };
    const pressU = async () => { await page.keyboard.press('u'); await page.waitForTimeout(50); return page.evaluate(() => window.pushes); };

    await open();
    assert.deepEqual(await pressU(), ['/test/project'], 'u leaves a freshly opened task');

    // Sending a follow-up hands the keyboard back to the page, like Gmail after a reply.
    await open();
    await page.locator('.followup-input').fill('The moon icon');
    await page.keyboard.press('Control+Enter');
    await page.waitForFunction(() => !document.querySelector('.followup-input').value);
    assert.equal(signals.at(-1)?.text, 'The moon icon', 'the follow-up was sent');
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('followup-input')), false, 'the composer gives up focus once sent');
    assert.deepEqual(await pressU(), ['/test/project'], 'u leaves right after a follow-up is sent');

    // A checkbox takes no letters, so letters stay shortcuts; its own keys stay its own.
    await open();
    await page.evaluate(() => document.querySelector('#tp-rail').insertAdjacentHTML('afterbegin', '<input type="checkbox" id="probe-box">'));
    await page.locator('#probe-box').click();
    assert.equal(await page.locator('#probe-box').isChecked(), true);
    await page.keyboard.press(' ');
    assert.equal(await page.locator('#probe-box').isChecked(), false, 'Space still toggles a focused checkbox');
    assert.deepEqual(await pressU(), ['/test/project'], 'u leaves with a checkbox focused');

    // A text field keeps every letter.
    await open();
    await page.locator('.followup-input').click();
    assert.deepEqual(await pressU(), [], 'u types in the composer instead of leaving');
    assert.equal(await page.locator('.followup-input').inputValue(), 'u');
    await page.locator('#task-notes').click();
    assert.deepEqual(await pressU(), [], 'u types in the notes too');

    assert.deepEqual(errors, []);
    console.log('task back shortcut browser regression passed');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
