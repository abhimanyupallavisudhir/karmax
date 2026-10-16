// The harness of web/new-tab-links-*.browser.test.cjs: the console against fixed
// fakes, and `opensInNewTab`, which checks that a Ctrl/⌘- or middle-click on
// something is left to the browser as a link to the expected URL.
const assert = require('node:assert/strict');
const { fakeConsole, launch, taskView } = require('./fake-console.cjs');

const ORIGIN = 'http://console.test';
const project = { id: 'p', organizationId: 'o', name: 'Workspace', config: {} };
const tag = { id: 'tag_ui', projectId: 'p', name: 'ui', kind: 'topic' };
const tasks = [
  { id: 't1', projectId: 'p', num: 1, title: 'Ship it', workflow: 'software-dev', params: {}, tags: ['tag_ui'], lastView: { stage: 'review', status: 'active' } },
  { id: 't2', projectId: 'p', num: 2, title: 'Half-written', workflow: 'software-dev', params: { draft: true }, tags: [], lastView: {} },
  { id: 't3', projectId: 'p', num: 3, title: 'Nightly', workflow: 'software-dev', params: { triggerState: 'armed', triggers: [{ kind: 'schedule', cron: '0 3 * * *' }] }, tags: [], lastView: {} },
  { id: 't4', projectId: 'p', num: 4, title: 'Polish it', workflow: 'software-dev', parentTaskId: 't1', params: {}, tags: [], lastView: { stage: 'review', status: 'active' } },
];
const schema = [{ name: 'software-dev', params: [], stages: [{ key: 'review', label: 'Review' }] }];
const notice = { id: 'n1', organizationId: 'o', kind: 'approval-requested', urgency: 'high', unread: true, actionable: true, createdAt: Date.now(),
  subject: { kind: 'credential', provider: 'claude', account: 'ops', reason: 'signed-out' } };

/** Runs `checks(helpers)` — each `check(name, fn)` in a fresh console — and exits non-zero on a failure. */
function runNewTabChecks(checks) {
  return (async () => {
    const browser = await launch();
    let failures = 0;
    const check = async (name, fn, { signedOut = false } = {}) => {
      const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 800 } });
      context.setDefaultTimeout(8000);
      const patched = [];
      await fakeConsole(context, { project, tasks, schema, api(p, request) {
        if (signedOut && p === '/api/session') return { authRequired: true, authenticated: false };
        if (p === '/api/projects/p/tags') return [tag];
        // Sectioned by tag, the list has a section per tag.
        if (p === '/api/projects/p/search' && /group:tag/.test(new URL(request.url()).searchParams.get('q')))
          return { tasks: [tasks[0]], total: 1, hierarchical: true, groups: [{ key: 'tag_ui', label: 'ui', tasks: [tasks[0]], children: [] }] };
        if (p === '/api/inbox') return [notice];
        if (p === '/api/organizations/o/search') return { tasks: tasks.slice(0, 2), total: 2 };
        if (p === '/api/organization-directory') return [{ id: 'o', name: 'Organization', slug: 'org', accessible: true }];
        if (p === '/api/tasks/t1') return taskView(tasks[0], { subTasks: ['t4'] });
        if (p === '/api/tasks/t4') return taskView(tasks[3], { parentTaskId: 't1' });
        if (p === '/api/inbox/n1' && request.method() === 'PATCH') { patched.push(p); return {}; }
      } });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      try {
        await fn({ context, page, patched });
        assert.deepEqual(errors, [], 'no page errors');
        console.log(`ok - ${name}`);
      } catch (error) {
        failures++;
        console.error(`not ok - ${name}\n${error.stack}`);
      } finally {
        await context.close();
      }
    };

    const open = async (page, path, ready) => {
      await page.goto(ORIGIN + path);
      await page.locator(ready).first().waitFor();
      await settled(page);
      await page.evaluate(() => { window.__sameDocument = true; });
    };
    // The list repaints as its search, tags and inbox land; click what stays.
    const settled = (page) => page.evaluate(() => new Promise((resolve) => {
      let timer = setTimeout(done, 150);
      const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, 150); });
      function done() { observer.disconnect(); resolve(); }
      observer.observe(document.body, { childList: true, subtree: true });
    }));
    // A modified click on `selector` is left to the browser — it reaches a link to
    // `expected` and nothing in the app cancels it, which is exactly when the
    // browser opens that link in a new tab — and this page stays where it was.
    // (Headless Chromium drops some real new tabs at random, so rather than wait
    // for one, the test reads the click's outcome once it has been dispatched.)
    const opensInNewTab = async ({ context, page }, selector, expected, how = { modifiers: ['Control'] }) => {
      await settled(page);
      const before = page.url();
      const history = await page.evaluate(() => history.length);
      await page.evaluate(() => {
        window.__activation = new Promise((resolve) => {
          const record = (event) => setTimeout(() => resolve({ href: event.target.closest('a[href]')?.href || null, prevented: event.defaultPrevented }));
          const type = (event) => { window.removeEventListener('click', type, true); window.removeEventListener('auxclick', type, true); record(event); };
          window.addEventListener('click', type, true);
          window.addEventListener('auxclick', type, true);
        });
      });
      await page.locator(selector).first().click(how);
      assert.deepEqual(await page.evaluate(() => window.__activation), { href: ORIGIN + expected, prevented: false }, `${selector} opens ${expected} in a new tab`);
      await page.waitForTimeout(50); // anything the click would have started here
      assert.equal(page.url(), before, 'this tab stays put');
      assert.equal(await page.evaluate(() => history.length), history, 'and writes no history');
      for (const other of context.pages()) if (other !== page) await other.close();
    };
    const sameDocument = (page) => page.evaluate(() => window.__sameDocument === true);

    await checks({ check, open, opensInNewTab, sameDocument, ORIGIN });

    await browser.close();
    if (failures) { console.error(`${failures} failed`); process.exit(1); }
  })();
}

module.exports = { runNewTabChecks };
