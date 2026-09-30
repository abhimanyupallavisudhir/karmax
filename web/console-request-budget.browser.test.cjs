// Request budgets for the console's hottest paths, measured in the full shell on
// fake /api + WS (RQ-3, RQ-6, RQ-9, UI-6, UI-8): boot, task open, j/k walking,
// organization switch, an organization-settings action, a busy event stream, and
// the public pages (which read no session).
// Every API response is delayed, so `depth` counts sequential round trips.
// Run: node web/console-request-budget.browser.test.cjs  (REQUEST_BUDGET_REPORT=1 prints only)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const LATENCY_MS = 40;
const report = process.env.REQUEST_BUDGET_REPORT === '1';

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    let log = [];
    const errors = [], sockets = [];
    const organizations = [{ id: 'o', name: 'Organization', slug: 'org' }, { id: 'o2', name: 'Second', slug: 'second' }];
    const projects = [{ id: 'p', organizationId: 'o', name: 'Workspace', config: {} }, { id: 'q', organizationId: 'o2', name: 'Other', config: {} }];
    const task = (n, projectId = 'p') => ({ id: `t${n}`, projectId, num: n, title: `Task ${n}`, workflow: 'software-dev', params: {}, tags: [], lastView: { stage: 'do', status: 'active' } });
    const tasks = { p: [1, 2, 3, 4, 5, 6].map(n => task(n)), q: [task(7, 'q')] };
    const sibling = { ...task(1), id: 'a1', num: undefined };
    const schema = [{ name: 'software-dev', params: [{ name: 'prompt', type: 'text', label: 'Prompt', scopes: ['task'], bind: 'prompt' }], stages: [{ key: 'do', label: 'Working' }] }];
    const watches = [];
    await context.routeWebSocket('**/ws*', ws => { sockets.push(ws); ws.onMessage(data => { const message = JSON.parse(data); if (message.type === 'watch') watches.push(message); }); });
    await context.route('http://console.test/**', async route => {
      const req = route.request(), url = new URL(req.url()), p = url.pathname;
      if (!p.startsWith('/api/')) {
        const file = /^\/[\w-]+\.js$|^\/styles\.css$/.test(p) && fs.existsSync(path.join(__dirname, p)) ? p.slice(1) : 'index.html';
        // CONSOLE_APP_JS measures another console build (e.g. the base revision) on the same fixture.
        const source = file === 'app.js' && process.env.CONSOLE_APP_JS ? process.env.CONSOLE_APP_JS : path.join(__dirname, file);
        return route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body: fs.readFileSync(source, 'utf8') });
      }
      const entry = { key: `${req.method()} ${p}`, start: Date.now(), end: Infinity };
      log.push(entry);
      await new Promise(resolve => setTimeout(resolve, LATENCY_MS));
      let data = [], m;
      if (p === '/api/meta') data = { siteName: 'Fixture', hostLocal: true, consoleRevision: 'one', agent: { provider: 'mock' }, worldProviders: [] };
      else if (p === '/api/launch') data = {};
      else if (p === '/api/session') data = { authenticated: true, user: { id: 'u', name: 'Tester' } };
      else if (p === '/api/settings/installation') data = { canManage: false };
      else if (p === '/api/organizations') data = organizations;
      else if (p === '/api/user/default-organization') data = { organizationId: 'o' };
      else if (p === '/api/projects') data = projects;
      else if ((m = p.match(/^\/api\/projects\/(\w+)$/))) data = projects.find(project => project.id === m[1]);
      else if (p === '/api/schema') data = schema;
      else if (p === '/api/contributions') data = { slots: [], commands: [], events: [] };
      else if (p === '/api/models') data = { providers: [] };
      else if (p.endsWith('/defaults') || p.startsWith('/api/defaults/')) data = { effective: {}, inherited: {} };
      else if ((m = p.match(/^\/api\/projects\/(\w+)\/tasks$/))) data = tasks[m[1]] || [];
      else if ((m = p.match(/^\/api\/projects\/(\w+)\/search$/))) data = { tasks: tasks[m[1]] || [], total: (tasks[m[1]] || []).length };
      else if ((m = p.match(/^\/api\/organizations\/\w+\/roles$/))) data = { canCreate: true, profiles: [], capabilityGroups: [], creatableCapabilities: [] };
      else if (p.endsWith('/payments/providers')) data = { providers: [], active: null };
      else if ((m = p.match(/^\/api\/organizations\/\w+\/(entitlements|usage|usage-policy|identity-policy)$/))) data = null;
      else if ((m = p.match(/^\/api\/organizations\/\w+\/(execution-policy)$/))) data = { worldProvider: 'worktree', resources: { cpu: 2, memoryMb: 2048 }, network: { unrestricted: true } };
      else if ((m = p.match(/^\/api\/organizations\/\w+\/github\/app$/))) data = { configured: false };
      else if ((m = p.match(/^\/api\/organizations\/\w+\/github\/identity$/))) data = { profile: null };
      else if ((m = p.match(/^\/api\/organizations\/\w+\/teams$/)) && req.method() === 'POST') data = { id: 'team', name: 'Team', slug: 'team' };
      else if ((m = p.match(/^\/api\/tasks\/(\w+)$/))) data = { taskId: m[1], projectId: 'p', title: `Task ${m[1]}`, workflow: 'software-dev', stage: 'do', status: 'active', messages: [], actions: [], state: {} };
      else if (p.endsWith('/sessions')) data = {};
      else if ((m = p.match(/^\/api\/tasks\/(\w+)\/attempts$/))) data = m[1] === 't1' ? { principalAttemptId: 't1', attempts: [task(1), sibling] } : { principalAttemptId: m[1], attempts: [] };
      else if (p.endsWith('/explanation-settings')) data = { effective: {} };
      else if (p.endsWith('/avatars')) data = { avatars: [], availability: { enabled: false } };
      else if (p === '/api/search/fields') data = [{ key: 'stage', label: 'Stage', type: 'enum', values: ['do'] }];
      else if (p.endsWith('/onboarding')) data = { display: 'hidden', steps: [] };
      route.fulfill({ json: data }).catch(() => {});
      entry.end = Date.now();
    });
    context.setDefaultTimeout(8000);
    const page = await context.newPage();
    page.on('pageerror', error => { errors.push(error.message); console.error('page:', error.stack); });
    // Let the page settle: no API request in flight or started for `quiet` ms.
    const settle = async (quiet = 400) => {
      for (let idle = 0; idle < quiet; idle += 50) {
        const busy = log.some(entry => entry.end === Infinity) || log.some(entry => Date.now() - entry.end < 50);
        if (busy) idle = 0;
        await page.waitForTimeout(50);
      }
    };
    const measure = async (name, action) => {
      log = [];
      await action();
      await settle();
      const depth = new Map();
      for (const entry of [...log].sort((a, b) => a.start - b.start))
        depth.set(entry, 1 + Math.max(0, ...log.filter(other => other.end <= entry.start).map(other => depth.get(other) || 0)));
      const counts = {};
      for (const entry of log) counts[entry.key] = (counts[entry.key] || 0) + 1;
      return { name, requests: log.length, depth: Math.max(0, ...depth.values()), counts };
    };
    const results = {};
    let walkedTo;
    const record = result => { results[result.name] = result; console.log(`${result.name}: ${result.requests} requests, ${result.depth} sequential round trips`); if (report) console.log(JSON.stringify(result.counts)); };

    record(await measure('boot', async () => {
      await page.goto('http://console.test/org/workspace');
      await page.locator('[data-id="t1"]').waitFor();
    }));
    record(await measure('task open', async () => {
      await page.locator('[data-id="t2"] .row-link').click();
      await page.locator('#tp-body').waitFor();
    }));
    if (!report) assert.deepEqual(watches.at(-1), { type: 'watch', projectId: 'p', taskId: 't2' }, 'the socket watches the open task');
    record(await measure('j/k walk (5 keys)', async () => {
      await page.evaluate(() => document.activeElement?.blur());
      for (let i = 0; i < 4; i++) await page.keyboard.press('j');
      await page.keyboard.press('k');
      await page.waitForTimeout(600);
      walkedTo = await page.evaluate(() => location.pathname);
      await page.locator('#tp-body').waitFor();
    }));
    console.log(`j/k walk ended at ${walkedTo}`);
    // Approval requests load for the tab that lists them, not for every task open.
    record(await measure('approvals tab', async () => {
      await page.locator('[data-tasktab="approvals"]').click();
      await page.locator('#task-approval-requests').waitFor();
    }));
    await page.evaluate(() => { history.pushState({ kx: 1 }, '', '/org/workspace'); dispatchEvent(new PopStateEvent('popstate')); });
    await page.locator('[data-id="t1"]').waitFor();
    await settle();
    // A non-principal attempt, a foreign project, other tasks' output: none is a list change.
    record(await measure('busy event stream (list)', async () => {
      for (let i = 0; i < 20; i++) {
        if (i % 4 === 0) await page.waitForTimeout(400);
        sockets.at(-1).send(JSON.stringify({ type: 'view.updated', taskId: 'a1', projectId: 'p', siblingAttempt: true, payload: { stage: 'do', status: 'active', agentTurn: i % 2 ? 'running' : null } }));
        sockets.at(-1).send(JSON.stringify({ type: 'view.updated', taskId: 't7', projectId: 'q', payload: { stage: 'do', status: 'active' } }));
        sockets.at(-1).send(JSON.stringify({ type: 'agent.output', taskId: 't3', projectId: 'p', payload: { source: 'assistant', text: `chunk ${i}` } }));
        sockets.at(-1).send(JSON.stringify({ type: 'agent.activity', taskId: 't3', projectId: 'p', payload: { kind: 'tool', title: `tool ${i}` } }));
      }
      await page.waitForTimeout(500);
    }));
    record(await measure('organization switch', async () => {
      await page.evaluate(() => { history.pushState({ kx: 1 }, '', '/second'); dispatchEvent(new PopStateEvent('popstate')); });
      await page.locator('[data-id="t7"]').waitFor();
    }));
    record(await measure('organization settings', async () => {
      await page.evaluate(() => { history.pushState({ kx: 1 }, '', '/second/settings'); dispatchEvent(new PopStateEvent('popstate')); });
      await page.waitForFunction(() => document.querySelector('#org-members') && !document.querySelector('#org-members').textContent.startsWith('Loading'));
    }));
    const panes = ['#org-plan .plan-summary, #org-plan *', '#org-github .github-org-actions', '#org-execution-pool', '#org-providers .provider-connection', '#org-runners #runner-create', '#org-storage #storage-connect', '#org-usage'];
    assert.deepEqual(await page.evaluate(selectors => selectors.filter(selector => !document.querySelector(selector)), panes), [], 'every organization pane paints');
    record(await measure('organization switch (settings)', async () => {
      await page.evaluate(() => { history.pushState({ kx: 1 }, '', '/org/settings'); dispatchEvent(new PopStateEvent('popstate')); });
      await page.waitForFunction(() => document.querySelector('#org-members') && document.querySelector('#org-switcher input, #org-switcher')?.outerHTML.includes('Organization'));
    }));
    record(await measure('organization action (create team)', async () => {
      await page.evaluate(() => { document.querySelector('#team-name').value = 'Team'; document.querySelector('#create-team').click(); });
    }));
    // A deep link into another organization boots straight into it.
    const deep = await context.newPage();
    deep.on('pageerror', error => { errors.push(error.message); console.error('page:', error.stack); });
    record(await measure('boot (other organization)', async () => {
      await deep.goto('http://console.test/second/other');
      await deep.locator('[data-id="t7"]').waitFor();
    }));
    // Public pages need no session; reading one has side effects (it provisions a
    // personal workspace and consumes the one-time onboarding flag).
    const publicPage = await context.newPage();
    record(await measure('public pages', async () => {
      for (const route of ['/legal', '/pricing', '/reset-password?token=x']) {
        await publicPage.goto(`http://console.test${route}`);
        await publicPage.waitForLoadState('load');
      }
    }));
    assert.deepEqual(errors, []);
    if (!report) {
      assert.equal(results['public pages'].counts['GET /api/session'], undefined, 'public pages never read the session');
      const budget = (name, requests, depth) => {
        assert.ok(results[name].requests <= requests, `${name}: ${results[name].requests} requests > ${requests}\n${JSON.stringify(results[name].counts)}`);
        if (depth != null) assert.ok(results[name].depth <= depth, `${name}: ${results[name].depth} round trips > ${depth}`);
      };
      budget('boot', 24, 5);
      budget('boot (other organization)', 24, 5);
      budget('organization action (create team)', 6);
      // The route that switches organization and the settings page it paints share one read.
      for (const key of ['GET /api/organizations/o2/members', 'GET /api/organizations/o2/teams', 'GET /api/organizations/o2/roles'])
        assert.equal(results['organization switch'].counts[key], 1, `an organization switch reads ${key} once`);
      for (const key of ['GET /api/organizations/o/members', 'GET /api/organizations/o/teams', 'GET /api/organizations/o/roles'])
        assert.ok((results['organization switch (settings)'].counts[key] || 0) <= 1, `an organization switch into settings reads ${key} at most once`);
      for (const name of ['organization switch', 'organization switch (settings)', 'organization action (create team)'])
        assert.equal(results[name].counts['GET /api/inbox'], undefined, `${name}: the inbox spans organizations and is not reloaded`);
      assert.ok(!Object.keys(results['boot (other organization)'].counts).some(key => key.includes('/organizations/o/')),
        'a deep link loads only its own organization');
      budget('busy event stream (list)', 0);
      budget('task open', 8, 1);
      assert.equal(walkedTo, '/org/workspace/tasks/5', 'every j/k press counts, even before the last task loaded');
      budget('j/k walk (5 keys)', 8, 1);
      for (const list of ['/api/vault/requests', '/api/permission-requests', '/api/authorization-requests'])
        assert.equal(results['approvals tab'].counts[`GET ${list}`], 1, `the Approvals tab loads ${list}`);
    }
    console.log('Console request budgets: ok');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
