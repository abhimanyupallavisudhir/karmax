// Real browser regression: a finished task's page keeps what it had while it
// ran. Its parent and its agent forks are archived out of the live task list
// once they finish, its sandbox is released, and its work summary gained the
// landing line — none of that may make the overview lose a section.
// SCREENSHOT_DIR=<dir> also writes screenshots. APP_SOURCE can test the baseline.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = __dirname;

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 1000 }, colorScheme: process.env.COLOR_SCHEME || 'light' });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const record = { id: 'child', projectId: 'p1', num: 12, title: 'Add the export button', workflow: 'software-dev', workflowVersion: '1.26.0',
      parentTaskId: 'parent', attemptNumber: 1, tags: [],
      params: { prompt: 'Add it', archived: true, _authorization: { level: 'developer', scope: 'projects', projectIds: ['p1'],
        capabilities: ['use-credential:item:vi_1'] } },
      lastView: { taskId: 'child', stage: 'done', status: 'done', state: {} } };
    // A live (active) fork is still in the list; the finished one is not.
    const liveFork = { id: 'fork-live', projectId: 'p1', num: 14, title: 'Try a menu instead', workflow: 'software-dev', tags: [],
      params: { prompt: 'menu', 'agent:do': { resumeFrom: { taskId: 'child', role: 'do' } } }, lastView: { stage: 'do', status: 'active' } };
    const view = {
      taskId: 'child', num: 12, title: record.title, workflow: 'software-dev', stage: 'done', status: 'done',
      state: { confirmed: true, worldReady: false }, branch: 'tavya/child', base: 'main', targetBranch: 'main',
      parentTaskId: 'parent', parentTask: { id: 'parent', num: 10, title: 'Ship reporting' },
      reviewInfo: { caption: undefined, summary: '3 file(s) changed.\n\nMerged into main as 1a2b3c4d.', completion: 'signalled',
        actions: [{ kind: 'open', label: 'Screenshot', target: 'shot.png' }] },
      prs: [{ repo: 'app', number: 7, url: 'https://github.com/o/app/pull/7', state: 'closed', merged: true }],
      forkSummaries: [
        { id: 'fork-done', num: 13, title: 'Try a toolbar icon', workflow: 'software-dev', lastView: { stage: 'done', status: 'done' }, forkOf: ['child'] },
        { id: 'fork-live', num: 14, title: 'Try a menu instead', workflow: 'software-dev', lastView: { stage: 'setup', status: 'active' }, forkOf: ['child'] },
      ],
      notes: 'Ask design about the icon', editableParams: [], agents: {}, actions: [], worldAvailable: false,
      messages: [{ id: 'm0', role: 'user', text: 'Add it', ts: 0 }],
    };
    await page.route('**/*', async (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p.startsWith('/api/')) {
        let data = [];
        if (p === '/api/tasks/child') data = view;
        else if (p.endsWith('/attempts')) data = { intentId: 'i1', principalAttemptId: 'child', attempts: [record] };
        else if (p.endsWith('/sessions')) data = {};
        else if (p.includes('/defaults/')) data = { task: { inherited: {} } };
        else if (p.includes('explanation-settings')) data = { effective: { enabled: false } };
        else if (p.endsWith('/credentials')) data = { credentials: [], task: { own: {}, enabled: [] } };
        else if (p.endsWith('/accounts')) data = { logins: [] };
        return route.fulfill({ json: data });
      }
      const file = path.join(root, p === '/' ? 'index.html' : p);
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.abort();
      let body = fs.readFileSync(p === '/app.js' && process.env.APP_SOURCE || file, 'utf8');
      if (p === '/app.js') body = body.replace(/^boot\(\)\.catch\(.*$/m, 'window.finishedTest = { S, openTask }; installLinkRouter();');
      return route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    await page.goto('http://finished.test/');
    await page.waitForFunction(() => window.finishedTest);
    const open = (tab) => page.evaluate(async ({ liveFork, tab }) => {
      const { S, openTask } = window.finishedTest;
      document.querySelector('#app').innerHTML = '<main id="main" style="height:960px;display:flex;flex-direction:column"></main>';
      // The live pool: active tasks only — neither the parent nor the finished fork.
      S.tasks = [liveFork]; S.projects = [{ id: 'p1', slug: 'project', name: 'Shop', organizationId: 'o1', config: {} }];
      S.projectId = 'p1'; S.organizationId = 'o1'; S.organizations = [{ id: 'o1', slug: 'test' }]; S.tags = [];
      S.meta = { workflows: [], hosted: true }; S.schema = [{ name: 'software-dev', params: [] }];
      S.selected = null; S.view = null; S.taskTab = null;
      await openTask('child', tab);
    }, { liveFork, tab });
    const shot = async (name, selector = '.task-page') => {
      if (!process.env.SCREENSHOT_DIR) return;
      fs.mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true });
      await page.locator(selector).screenshot({ path: path.join(process.env.SCREENSHOT_DIR, name) });
    };

    await open('overview');
    await page.waitForSelector('.agent-forks');
    await shot('finished-task-overview.png');
    const overview = await page.locator('.task-page').innerText();
    assert.match(overview, /Sub-task of\s*#10 Ship reporting/, 'the finished parent keeps its number and title');
    assert.match(overview, /work summary[\s\S]*3 file\(s\) changed\.[\s\S]*Merged into main as 1a2b3c4d\./i, 'the work summary keeps what the work was');
    assert.match(overview, /Screenshot/, 'review outputs stay openable');
    assert.match(overview, /2 task forks/, 'finished and live forks are both listed');
    assert.equal(await page.locator('a[href$="/tasks/fork-done"] .subtask-state.done').count(), 1, 'the finished fork shows as done');
    assert.match(overview, /PR #7\s*merged/i, 'the merged pull request stays linked');

    await open('checkin');
    await page.waitForSelector('#ck-term-item');
    assert.match(await page.locator('#ck-term-item').innerText(), /Workspace closed/, 'a finished task does not claim its workspace never started');

    await open('parameters');
    await page.waitForSelector('#tp-auth-frozen');
    await shot('finished-task-parameters.png', '#tp-auth-frozen');
    assert.match(await page.locator('#tp-auth-frozen').innerText(), /Developer · Shop · 1 vault credential/, 'authorization stays as a read-only record');
    assert.equal(await page.locator('#tp-auth-save').count(), 0, 'and cannot be edited');

    assert.deepEqual(errors, []);
    console.log('finished task overview browser regression passed');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
