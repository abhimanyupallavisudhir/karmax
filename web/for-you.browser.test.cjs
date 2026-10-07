// Creating tasks from the organization home, and the bell's page: Home creates
// a task in any of the organization's projects (a project picker in the quick
// composer and on the task form's "← New task" bar), the topbar has no second
// search, and the bell opens one Home-like list of what waits on you in every
// organization, each row naming its organization and project as a slug.
// Run: node web/for-you.browser.test.cjs   (FOR_YOU_SCREENSHOTS=<dir> also saves screenshots)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fakeConsole, launch, taskView } = require('../tests/helpers/fake-console.cjs');

(async () => {
  const browser = await launch();
  const shots = process.env.FOR_YOU_SCREENSHOTS;
  if (shots) fs.mkdirSync(shots, { recursive: true });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 760 } });
    const errors = [];
    const organizations = [{ id: 'o', name: 'Organization', slug: 'org' }, { id: 'o2', name: 'Side Gig', slug: 'side-gig' }];
    const web = { id: 'p', organizationId: 'o', name: 'Website', config: {} };
    const mobile = { id: 'q', organizationId: 'o', name: 'Mobile App', config: {} };
    const landing = { id: 'r', organizationId: 'o2', name: 'Landing', config: {} };
    const projects = [web, mobile, landing];
    const task = (n, projectId, title, lastView, extra = {}) =>
      ({ id: `t${n}`, projectId, num: n, title, workflow: 'software-dev', params: {}, tags: [], createdAt: 100 - n, lastView, ...extra });
    const tasks = [
      task(1, 'p', 'Checkout page: keep the cart when signing in', { stage: 'review', status: 'waiting', waitingFor: { kind: 'human' } }),
      task(2, 'q', 'Offline mode for the reading list', { stage: 'do', status: 'active' }),
      task(3, 'r', 'Pricing page copy', { stage: 'do', status: 'waiting', waitingFor: { kind: 'human', reason: 'input' } }),
    ];
    const reasons = { t1: ['review-requested'], t3: ['escalated'] };
    const slug = { p: 'website', q: 'mobile-app', r: 'landing' };
    const inbox = {
      o: [{ id: 'i1', organizationId: 'o', kind: 'review-requested', unread: true, actionable: true, urgency: 'high', createdAt: Date.now(), taskId: 't1',
        task: { id: 't1', num: 1, title: tasks[0].title, projectId: 'p', status: 'waiting' } }],
      o2: [
        { id: 'i3', organizationId: 'o2', kind: 'escalated', unread: false, actionable: true, urgency: 'normal', createdAt: Date.now(), taskId: 't3',
          task: { id: 't3', num: 3, title: tasks[2].title, projectId: 'r', status: 'waiting' } },
        { id: 'i4', organizationId: 'o2', kind: 'approval-requested', unread: true, actionable: true, urgency: 'normal', createdAt: Date.now(),
          subject: { kind: 'credential', provider: 'claude', account: 'ops', reason: 'signed-out' } },
      ],
    };
    const schema = [{ name: 'software-dev', label: 'Software development',
      params: [{ name: 'prompt', type: 'text', label: 'Prompt', scopes: ['task'], bind: 'prompt' }], stages: [{ key: 'do', label: 'Working' }] }];
    const searches = [], created = [], patched = [];
    const evaluate = (q, scope) => {
      const forMe = /(^|\s)for:me\b/.test(q);
      const project = q.match(/project:(\S+)/)?.[1];
      const listed = tasks.filter((t) => scope.includes(t.projectId) && (!forMe || reasons[t.id]) && (!project || slug[t.projectId] === project));
      return { tasks: listed, total: listed.length, offset: 0, limit: 200, tags: [],
        projects: projects.filter((p) => scope.includes(p.id)).map((p) => ({ id: p.id, name: p.name, slug: slug[p.id], organizationId: p.organizationId })),
        ...(forMe ? { reasons: Object.fromEntries(listed.map((t) => [t.id, reasons[t.id]])) } : {}) };
    };
    await fakeConsole(context, { project: web, tasks, schema, async api(p, req, url) {
      if (p === '/api/organizations') return organizations;
      if (p === '/api/projects') return projects;
      if (p === '/api/projects/q') return mobile;
      if (p === '/api/inbox' && req.method() === 'GET') return inbox[url.searchParams.get('organizationId')] || [];
      if (p === '/api/inbox' && req.method() === 'PATCH') {
        const ids = req.postDataJSON().ids;
        patched.push(...ids);
        return inbox[url.searchParams.get('organizationId')].filter((item) => ids.includes(item.id)).map((item) => ({ ...item, unread: false }));
      }
      if (p === '/api/organizations/o/search') { searches.push(`o:${url.searchParams.get('q')}`); return evaluate(url.searchParams.get('q') || '', ['p', 'q']); }
      if (p === '/api/search') { searches.push(`all:${url.searchParams.get('q')}`); return evaluate(url.searchParams.get('q') || '', ['p', 'q', 'r']); }
      if (p === '/api/search/fields') return [{ key: 'for', label: 'For', type: 'text' }, { key: 'project', label: 'Project', type: 'text', groupable: true }];
      const create = p.match(/^\/api\/projects\/([pqr])\/tasks$/);
      if (create && req.method() === 'POST') {
        const body = req.postDataJSON();
        created.push({ projectId: create[1], body });
        return { id: `new${created.length}`, num: 10 + created.length, projectId: create[1], title: body.title || body.params?.prompt, params: body.params || {} };
      }
      const view = p.match(/^\/api\/tasks\/(t\d)$/)?.[1];
      if (view) return taskView(tasks.find((t) => t.id === view));
    } });
    context.setDefaultTimeout(8000);
    const page = await context.newPage();
    page.on('pageerror', (error) => { errors.push(error.message); console.error('page:', error.message); });
    const rows = async () => (await page.locator('#main .task-row[data-id]').evaluateAll((els) => els.map((el) => el.dataset.id))).sort();
    const settle = () => page.waitForFunction(() => !document.querySelector('.search-box.searching'));

    // ── Home: one search, and a composer that picks its project ──────────────
    await page.goto('http://console.test/org');
    await page.locator('[data-id="t1"]').waitFor();
    await settle();
    assert.equal(await page.locator('#topbar-search').count(), 0, 'Home is the search: no second one in the topbar');
    assert.equal(await page.getByText('Search everything').count(), 0);
    const label = page.locator('[data-id="t1"] .task-project');
    assert.equal(await label.innerText(), 'website', 'a row names its project by slug');
    assert.equal(await page.locator('[data-id="t1"] .chip.task-project').count(), 0, 'a project label is not a status chip');
    const style = await label.evaluate((el) => { const s = getComputedStyle(el); return { font: s.fontFamily, border: s.borderTopWidth, background: s.backgroundColor }; });
    assert.match(style.font, /mono/i, 'a monospace slug');
    assert.equal(style.border, '0px');
    assert.equal(style.background, 'rgba(0, 0, 0, 0)', 'no pill behind it');

    const pick = page.locator('#new-task-project');
    assert.equal(await pick.innerText(), 'website', 'new tasks go to the current project by default');
    await pick.click();
    const menu = page.locator('.project-pick-menu:not([hidden])');
    assert.deepEqual(await menu.locator('[role="option"]').allInnerTexts(), ['website', 'mobile-app'], 'the organization\'s projects');
    if (shots) await page.screenshot({ path: path.join(shots, 'home-composer-picker.png') });
    await menu.locator('[data-project="q"]').click();
    assert.equal(await pick.innerText(), 'mobile-app');
    await page.locator('#new-task').fill('Sync reading positions');
    await page.locator('#new-task').press('Control+Enter');
    await page.waitForFunction(() => !document.querySelector('#new-task').value);
    assert.deepEqual(created.map((c) => [c.projectId, c.body.title]), [['q', 'Sync reading positions']], 'created in the chosen project');
    await page.reload();
    await page.locator('[data-id="t1"]').waitFor();
    assert.equal(await page.locator('#new-task-project').innerText(), 'mobile-app', 'the choice is remembered');

    // ── the full form: "← New task" with a project dropdown ──────────────────
    await page.locator('#new-task').fill('Dark mode');
    await page.locator('#new-task').press('Enter');
    const formPick = page.locator('#tf-project');
    await formPick.waitFor();
    assert.equal(await formPick.innerText(), 'mobile-app', 'the form opens in the composer\'s project');
    assert.equal(await page.locator('#tf-page textarea').first().inputValue(), 'Dark mode');
    await formPick.click();
    if (shots) await page.screenshot({ path: path.join(shots, 'task-form-project-picker.png') });
    await page.locator('.project-pick-menu:not([hidden]) [data-project="p"]').click();
    await page.waitForFunction(() => document.querySelector('#tf-project')?.innerText === 'website');
    assert.equal(await page.locator('#tf-page textarea').first().inputValue(), 'Dark mode', 'switching keeps what you wrote');
    await page.locator('#tf-queue').click();
    await page.waitForFunction(() => !document.querySelector('#tf-page'));
    assert.deepEqual(created.at(-1).projectId, 'p', 'the form runs the task in the chosen project');
    assert.equal(created.at(-1).body.params.prompt, 'Dark mode');
    // A project's own list has no picker: the project is the page.
    await page.goto('http://console.test/org/website');
    await page.locator('#new-task').waitFor();
    assert.equal(await page.locator('#new-task-project').count(), 0);

    // ── the bell: what waits on you in every organization ─────────────────────
    assert.equal(await page.locator('#bell').getAttribute('href'), '/inbox');
    await page.locator('#bell').click();
    await page.waitForFunction(() => location.pathname === '/inbox');
    await page.locator('[data-id="t3"]').waitFor();
    await settle();
    assert.ok(searches.includes('all:for:me -is:archived'), `searches every organization for:me: ${searches}`);
    assert.deepEqual(await rows(), ['t1', 't3']);
    assert.equal(await page.locator('.view-chip.active').getAttribute('data-view'), '__for_me__');
    assert.equal(await page.locator('[data-id="t3"] .task-project').innerText(), 'side-gig/landing', 'rows name organization and project');
    assert.equal(await page.locator('[data-id="t1"] .task-project').innerText(), 'org/website');
    assert.equal(await page.locator('#new-task').count(), 0, 'tasks are created on an organization\'s Home');
    assert.ok(await page.locator('[data-id="t1"]').evaluate((el) => el.classList.contains('unread')), 'a new ask stands out');
    assert.ok(!(await page.locator('[data-id="t3"]').evaluate((el) => el.classList.contains('unread'))));
    const notice = page.locator('.inbox-row[data-inbox="i4"]');
    assert.match(await notice.innerText(), /claude:ops/, 'asks that are not tasks are listed too');
    assert.equal(await page.locator('#bell-badge').innerText(), '2');
    if (shots) await page.screenshot({ path: path.join(shots, 'for-you.png') });

    // Every query works here; All is one click away.
    await page.locator('.view-chip[data-view="__all__"]').click();
    await page.waitForFunction(() => location.pathname === '/inbox' && location.search === '?q=');
    await page.locator('[data-id="t2"]').waitFor();
    await settle();
    assert.deepEqual(await rows(), ['t1', 't2', 't3']);
    assert.equal(await page.locator('.inbox-row[data-inbox="i4"]').count(), 0, 'notices belong to For me');

    // Opening a task reads its asks.
    await page.goto('http://console.test/inbox');
    await page.locator('[data-id="t1"]').waitFor();
    await page.locator('[data-id="t1"] .row-link').click();
    await page.waitForFunction(() => location.pathname === '/org/website/tasks/1');
    await page.waitForFunction(() => document.querySelector('#bell-badge')?.innerText === '1');
    assert.deepEqual(patched, ['i1']);

    // The old organization-scoped address still lands here.
    await page.goto('http://console.test/org/inbox/review-requested');
    await page.waitForFunction(() => location.pathname === '/inbox');
    await page.locator('[data-id="t3"]').waitFor();
    assert.deepEqual(errors, []);
    console.log('for-you.browser: ok');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exit(1); });
