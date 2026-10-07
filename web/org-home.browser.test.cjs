// The organization home: `/` lands on `/<org>`, one task list over every
// project that opens on "For me" (what waits on you, each row saying why), with
// "All" one click away and bookmarkable, a project filter, project permalinks,
// a composer that creates the task in a project you pick,
// the logo as the way home, and a ☰ that folds the sidebar on a wide screen.
// Run: node web/org-home.browser.test.cjs   (HOME_SCREENSHOTS=<dir> also saves screenshots)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fakeConsole, launch, taskView } = require('../tests/helpers/fake-console.cjs');

(async () => {
  const browser = await launch();
  const shots = process.env.HOME_SCREENSHOTS;
  if (shots) fs.mkdirSync(shots, { recursive: true });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 760 } });
    const errors = [];
    const web = { id: 'p', organizationId: 'o', name: 'Website', config: {} };
    const mobile = { id: 'q', organizationId: 'o', name: 'Mobile App', config: {} };
    const task = (n, projectId, title, lastView, extra = {}) =>
      ({ id: `t${n}`, projectId, num: n, title, workflow: 'software-dev', params: {}, tags: [], createdAt: 100 - n, lastView, ...extra });
    const tasks = [
      task(1, 'p', 'Checkout page: keep the cart when signing in', { stage: 'review', status: 'waiting', waitingFor: { kind: 'human' } }),
      task(2, 'q', 'Offline mode for the reading list', undefined, { params: { draft: true }, createdBy: { kind: 'user', userId: 'u' } }),
      task(3, 'p', 'Migrate the image pipeline to AVIF', { stage: 'do', status: 'active' }),
      task(4, 'q', 'Which push provider should we use?', { stage: 'do', status: 'waiting', waitingFor: { kind: 'human', reason: 'input' } }, { parentTaskId: 't5' }),
      task(5, 'q', 'Push notifications', { stage: 'do', status: 'active' }),
      task(6, 'p', 'Grant the deploy key for staging', { stage: 'do', status: 'waiting', waitingFor: { kind: 'human' }, approvalRequests: 1 }),
    ];
    const reasons = { t1: ['review-requested'], t2: ['draft'], t4: ['escalated'], t6: ['approval-requested', 'mentioned'] };
    const slug = { p: 'website', q: 'mobile-app' };
    const searches = [];
    // The organization search, evaluated just enough for these queries.
    const evaluate = (q) => {
      const forMe = /(^|\s)for:me\b/.test(q);
      const project = q.match(/project:(\S+)/)?.[1];
      const hidden = (t) => (/-is:subtask/.test(q) && t.parentTaskId) || (/-is:archived/.test(q) && t.params.archived);
      const listed = tasks.filter((t) => !hidden(t) && (!forMe || reasons[t.id]) && (!project || slug[t.projectId] === project));
      return { tasks: listed, total: listed.length, offset: 0, limit: 200, projects: [], tags: [],
        ...(forMe ? { reasons: Object.fromEntries(listed.map((t) => [t.id, reasons[t.id]])) } : {}) };
    };
    const { requests } = await fakeConsole(context, { project: web, tasks, async api(p, req, url) {
      if (p === '/api/projects') return [web, mobile];
      if (p === '/api/projects/q') return mobile;
      if (p === '/api/organizations/o/search') { searches.push(url.searchParams.get('q')); return evaluate(url.searchParams.get('q') || ''); }
      if (p === '/api/projects/p/search') { searches.push(`p:${url.searchParams.get('q')}`); return evaluate(`${url.searchParams.get('q') || ''} project:website`); }
      if (p === '/api/projects/p/tasks') return tasks.filter((t) => t.projectId === 'p');
      if (p === '/api/search/fields') return [{ key: 'for', label: 'For', type: 'text' }, { key: 'project', label: 'Project', type: 'text', groupable: true },
        { key: 'is', label: 'Is', type: 'facet', options: [] }, { key: 'status', label: 'Status', type: 'enum', options: [] }];
      const view = p.match(/^\/api\/tasks\/(t\d)$/)?.[1];
      if (view) return taskView(tasks.find((t) => t.id === view));
    } });
    context.setDefaultTimeout(8000);
    const page = await context.newPage();
    page.on('pageerror', (error) => { errors.push(error.message); console.error('page:', error.message); });
    const path_ = () => page.evaluate(() => location.pathname + location.search);
    const rows = async () => (await page.locator('#main .task-row').evaluateAll((els) => els.map((el) => el.dataset.id || el.dataset.draft))).sort();
    const activeView = () => page.locator('.view-chip.active').getAttribute('data-view');
    const settle = () => page.waitForFunction(() => !document.querySelector('.search-box.searching'));

    // ── `/` lands on the organization home, For me first ─────────────────────
    await page.goto('http://console.test/');
    await page.waitForFunction(() => location.pathname === '/org');
    await page.locator('[data-id="t1"]').waitFor();
    await settle();
    assert.equal(await path_(), '/org', 'the home is the bare organization path');
    assert.equal(await activeView(), '__for_me__', 'the home opens on For me');
    assert.deepEqual(await rows(), ['t1', 't2', 't4', 't6'], 'what waits on you — a sub-task too — and your draft');
    assert.ok(searches.includes('for:me -is:archived'), `a for: search keeps sub-tasks: ${searches}`);
    const chips = await page.locator('.view-chip[data-view]').evaluateAll((els) => els.map((el) => el.dataset.view));
    assert.deepEqual(chips.slice(0, 2), ['__for_me__', '__all__'], 'For me, then All');
    assert.equal(await page.locator('#save-view').count(), 0, 'saved views belong to projects');
    assert.equal(await page.locator('#new-task-project').innerText(), 'website', 'new tasks start in a project you pick');
    const review = page.locator('[data-id="t1"] .chip.attention');
    assert.equal(await review.innerText(), 'Review');
    assert.equal(await review.getAttribute('title'), 'Waiting for your review', 'the reason is explained in a tooltip');
    assert.equal(await page.locator('[data-id="t6"] .chip.attention').innerText(), 'Approval', 'an ask outranks a mention');
    assert.equal(await page.locator('[data-id="t4"] .task-project').innerText(), 'mobile-app', 'rows name their project by slug');
    assert.equal(await page.locator('[data-id="t1"] .row-link').getAttribute('href'), '/org/website/tasks/1', 'rows link to their project permalink');
    assert.equal(await page.locator('#brand-home').getAttribute('href'), '/org', 'the logo links home');
    if (shots) await page.screenshot({ path: path.join(shots, 'home-desktop.png') });

    // ── All is one click and a bookmark ───────────────────────────────────────
    await page.locator('.view-chip[data-view="__all__"]').click();
    await page.waitForFunction(() => location.search === '?q=');
    await page.locator('[data-id="t3"]').waitFor();
    await settle();
    assert.deepEqual(await rows(), ['t1', 't2', 't3', 't5', 't6'], 'All hides sub-tasks as before');
    await page.reload();
    await page.locator('[data-id="t3"]').waitFor();
    assert.equal(await activeView(), '__all__', 'a reloaded All stays All');

    // ── the project filter is a project: clause ──────────────────────────────
    await page.locator('#q-project').selectOption('mobile-app');
    await page.waitForFunction(() => location.search === '?q=project:mobile-app');
    await page.waitForFunction(() => !document.querySelector('[data-id="t3"]'));
    await settle();
    assert.deepEqual(await rows(), ['t2', 't5'], 'only that project');
    assert.equal(await page.locator('#task-search').inputValue(), 'project:mobile-app');
    await page.locator('#q-project').selectOption('');
    await page.waitForFunction(() => location.search === '?q=');

    // ── a row opens its project's task; the logo comes back home ──────────────
    await page.locator('[data-id="t1"] .row-link').click();
    await page.waitForFunction(() => location.pathname === '/org/website/tasks/1');
    await page.locator('#tp-body').waitFor();
    await page.locator('#brand-home').click();
    await page.waitForFunction(() => location.pathname === '/org' && !location.search);
    await page.locator('[data-id="t1"]').waitFor();
    assert.equal(await activeView(), '__for_me__', 'the logo opens the default home');

    // ── a project list opens on For me too ───────────────────────────────────
    await page.locator('.project-link[data-project="p"]').click();
    await page.waitForFunction(() => location.pathname === '/org/website');
    for (let i = 0; i < 80 && !searches.includes('p:for:me -is:archived'); i++) await page.waitForTimeout(100);
    assert.ok(searches.includes('p:for:me -is:archived'), 'the project list searches for:me');
    await page.locator('[data-id="t1"]').waitFor();
    await settle();
    assert.equal(await path_(), '/org/website', 'a project list\'s default view is the bare path');
    assert.equal(await activeView(), '__for_me__');

    // ── ☰ folds the sidebar on a wide screen, remembered ──────────────────────
    const toggle = page.locator('#mobile-menu');
    assert.ok(await toggle.isVisible(), 'the menu button is there on a desktop');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    await toggle.click();
    await page.waitForFunction(() => document.querySelector('#rail').getBoundingClientRect().width < 1);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#rail').isVisible(), false, 'the folded rail is out of sight');
    assert.ok(await page.locator('#rail').evaluate((rail) => rail.inert), 'and out of the tab order');
    if (shots) {
      await page.goto('http://console.test/org');
      await page.locator('[data-id="t1"]').waitFor();
      await settle();
      await page.screenshot({ path: path.join(shots, 'home-desktop-collapsed.png') });
    }
    await page.reload();
    await page.locator('[data-id="t1"]').waitFor();
    assert.equal(await page.locator('#rail').isVisible(), false, 'folded stays folded after a reload');
    await toggle.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#rail').getBoundingClientRect().width > 200);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true', 'the keyboard unfolds it');

    // ── a phone keeps its sliding menu ────────────────────────────────────────
    await page.locator('#mobile-menu').click(); // folded on the desktop…
    await page.setViewportSize({ width: 390, height: 780 });
    await page.goto('http://console.test/org');
    await page.locator('[data-id="t1"]').waitFor();
    await settle();
    if (shots) await page.screenshot({ path: path.join(shots, 'home-mobile.png') });
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    await toggle.click();
    await page.waitForFunction(() => document.querySelector('#rail').classList.contains('mobile-open'));
    assert.ok(await page.locator('#rail .project-link').first().isVisible(), '…yet the phone menu still opens the rail');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    if (shots) { await page.waitForTimeout(250); await page.screenshot({ path: path.join(shots, 'home-mobile-menu.png') }); }

    assert.deepEqual(errors, []);
    assert.ok(!requests.some((r) => r.startsWith('GET /api/projects/q/search')), 'the home reads one organization search, not one per project');
    console.log('Organization home: ok');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exit(1); });
