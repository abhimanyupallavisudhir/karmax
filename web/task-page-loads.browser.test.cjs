// What the task page loads, and that nothing loaded is lost: a dismissed
// decision still blocks its agent, so the page loads it and its Approval Requests
// tab shows it (the conversation leaves it out); a
// websocket refresh racing the approvals load keeps what that load found; a j/k
// walk continues from the page actually open; and agent review HTML is fetched
// once per content, not on every repaint (UI-6).
// Run: node web/task-page-loads.browser.test.cjs
const assert = require('node:assert/strict');
const { fakeConsole, launch, taskView } = require('../tests/helpers/fake-console.cjs');

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const browser = await launch();
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const errors = [];
    const project = { id: 'p', organizationId: 'o', name: 'Workspace', config: {} };
    const task = (n, lastView = { stage: 'do', status: 'active' }) =>
      ({ id: `t${n}`, projectId: 'p', num: n, title: `Task ${n}`, workflow: 'software-dev', params: {}, tags: [], lastView });
    const tasks = [1, 2, 3, 4, 5, 6].map(n => task(n));
    const schema = [{ name: 'software-dev', params: [], stages: [{ key: 'do', label: 'Working' }, { key: 'review', label: 'Review' }] }];
    const permission = (id, fields = {}) => ({ id, taskId: 't1', status: 'pending', role: 'do', capabilities: ['task:read'], audience: ['@owners'], reason: 'needs it', ...fields });
    const permissions = {
      t1: [permission('dismissed', { dismissed: { by: 'u' } })],
      t2: [permission('raced', { taskId: 't2' })],
    };
    // The gateway's projection: approvalRequests counts what still notifies,
    // pendingDecisions every pending decision, dismissed ones included.
    const views = {
      t1: { pendingDecisions: 1 },
      t2: { approvalRequests: 1, pendingDecisions: 1 },
      t6: { stage: 'review', status: 'waiting', reviewInfo: { caption: 'Check it', html: '<p>first</p>' } },
    };
    const viewReads = {};
    let slowRefresh = false;
    const { requests, sockets } = await fakeConsole(context, { project, tasks, schema, async api(p, req, url) {
      const view = p.match(/^\/api\/tasks\/(t\d)$/)?.[1];
      if (view) {
        viewReads[view] = (viewReads[view] || 0) + 1;
        if (slowRefresh && viewReads[view] > 1) await wait(700);
        return taskView(tasks.find(t => t.id === view), views[view]);
      }
      if (p === '/api/permission-requests') { await wait(300); return permissions[url.searchParams.get('taskId')] || []; }
      if (p === '/api/tasks/t6/review-info.html') return `<!doctype html>${views.t6.reviewInfo.html}`;
    } });
    context.setDefaultTimeout(8000);
    const page = await context.newPage();
    page.on('pageerror', error => { errors.push(error.message); console.error('page:', error.message); });
    const send = (event) => sockets.at(-1).send(JSON.stringify({ projectId: 'p', ts: Date.now(), ...event }));

    // A dismissed decision is still pending: it is loaded, kept out of the
    // conversation, and answerable on the Approval Requests tab.
    await page.goto('http://console.test/org/workspace/tasks/1/checkin');
    await page.locator('#ck-thread').waitFor();
    for (let i = 0; i < 50 && !requests.some(r => r.startsWith('GET /api/permission-requests')); i++) await wait(100);
    await wait(400); // the approvals load (300 ms) lands and repaints
    assert.equal(await page.locator('#ck-thread [data-preq="dismissed"]').count(), 0, 'a dismissed decision leaves the conversation');
    await page.locator('[data-tasktab="approvals"]').click();
    await page.locator('.approval-request-dismissed[data-preq="dismissed"] [data-preq-act="approve"]').waitFor();

    // A refresh that started before the approvals load finished keeps what it found.
    slowRefresh = true;
    await page.evaluate(() => { history.pushState({ kx: 1 }, '', '/org/workspace/tasks/2/checkin'); dispatchEvent(new PopStateEvent('popstate')); });
    await page.locator('#ck-thread').waitFor();
    send({ type: 'view.updated', taskId: 't2', payload: { stage: 'do', status: 'active' } });
    await page.locator('#ck-thread [data-preq="raced"]').waitFor();
    await page.waitForFunction(() => !document.querySelector('.task-page[aria-busy="true"]'));
    await wait(900); // the racing refresh lands
    assert.equal(await page.locator('#ck-thread [data-preq="raced"]').count(), 1, 'a racing refresh keeps the loaded decision');
    slowRefresh = false;

    // A walk step whose route another navigation supersedes never steers the next key.
    await page.evaluate(() => { history.pushState({ kx: 1 }, '', '/org/workspace/tasks/1'); dispatchEvent(new PopStateEvent('popstate')); });
    await page.locator('#tp-body').waitFor();
    await page.evaluate(() => {
      document.activeElement?.blur();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
      history.pushState({ kx: 1 }, '', '/org/workspace/tasks/3'); dispatchEvent(new PopStateEvent('popstate'));
    });
    await page.waitForFunction(() => document.querySelector('.task-page:not([aria-busy="true"]) #tp-body') && location.pathname === '/org/workspace/tasks/3');
    await wait(300);
    assert.equal(await page.evaluate(() => location.pathname), '/org/workspace/tasks/3', 'the superseding route wins');
    await page.keyboard.press('j');
    await page.waitForFunction(() => location.pathname !== '/org/workspace/tasks/3');
    assert.equal(await page.evaluate(() => location.pathname), '/org/workspace/tasks/4', 'j steps from the open task');

    // Review HTML is fetched once per content, however often the page repaints.
    await page.evaluate(() => { history.pushState({ kx: 1 }, '', '/org/workspace/tasks/6/overview'); dispatchEvent(new PopStateEvent('popstate')); });
    await page.locator('.review iframe').waitFor();
    await page.evaluate(() => { document.querySelector('.review iframe').original = true; });
    for (let i = 0; i < 3; i++) {
      send({ type: 'view.updated', taskId: 't6', payload: { stage: 'review', status: 'waiting' } });
      await wait(150);
    }
    await wait(300);
    const reviewReads = () => requests.filter(r => r === 'GET /api/tasks/t6/review-info.html').length;
    assert.ok(viewReads.t6 >= 3, 'the page repainted');
    assert.equal(reviewReads(), 1, 'a repaint keeps the review frame');
    assert.equal(await page.evaluate(() => document.querySelector('.review iframe').original), true);
    views.t6.reviewInfo = { caption: 'Check it', html: '<p>second</p>' };
    send({ type: 'view.updated', taskId: 't6', payload: { stage: 'review', status: 'waiting' } });
    await page.waitForFunction(() => !document.querySelector('.review iframe').original);
    await wait(300);
    assert.equal(reviewReads(), 2, 'new review content loads once');

    assert.deepEqual(errors, []);
    console.log('Task page loads: ok');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
