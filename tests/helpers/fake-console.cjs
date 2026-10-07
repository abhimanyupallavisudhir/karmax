// The shipped console shell (web/) in Chromium against deterministic /api and
// WebSocket fakes, for browser tests that need the whole shell but not a
// gateway (tests/helpers/browser.ts drives a real one). A test supplies its
// fixtures and answers the requests it is about; everything else gets what a
// signed-in console with one project needs to boot. It lives outside web/ so
// the gateway never serves it.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const WEB = path.join(__dirname, '..', '..', 'web');
const ASSETS = new Set(['/app.js', '/styles.css', '/markdown.js', '/totp-qr.js', '/register-service-worker.js']);
const REPLY = Symbol('reply');

const launch = () => chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });

/** An answer other than 200 JSON, e.g. `reply(503, { error: 'Search temporarily unavailable' })`. */
const reply = (status, json) => ({ [REPLY]: true, status, json });

/** A task's detail view as the gateway returns it. */
const taskView = (task, fields = {}) => ({ taskId: task.id, projectId: task.projectId, title: task.title, workflow: task.workflow,
  stage: task.lastView?.stage, status: task.lastView?.status, messages: [], actions: [], state: {}, ...fields });

/**
 * Serves the console at `origin` in `context`. `api(pathname, request, url)`
 * answers first; returning undefined falls through to the defaults. Returns
 * the requests seen ("GET /api/…") and the console's sockets, newest last.
 */
async function fakeConsole(context, { origin = 'http://console.test', project, tasks = [], schema = [], api = () => undefined }) {
  const requests = [], sockets = [];
  const organization = { id: project.organizationId, name: 'Organization', slug: 'org' };
  const byId = (p, suffix = '') => tasks.find((task) => p === `/api/tasks/${task.id}${suffix}`);
  const defaults = (p) => {
    if (p === '/api/meta') return { siteName: 'Fixture', hostLocal: true, consoleRevision: 'one', agent: { provider: 'mock' }, worldProviders: [] };
    if (p === '/api/launch') return {};
    if (p === '/api/session') return { authenticated: true, user: { id: 'u', name: 'Tester' } };
    if (p === '/api/settings/installation') return { canManage: false };
    if (p === '/api/organizations') return [organization];
    if (p === '/api/user/default-organization') return { organizationId: organization.id };
    if (p === '/api/projects') return [project];
    if (p === `/api/projects/${project.id}`) return project;
    if (p === '/api/schema') return schema;
    if (p === '/api/contributions') return { slots: [], commands: [], events: [] };
    if (p === '/api/models') return { providers: [] };
    // Organization settings panes read objects, not lists.
    if (p === `/api/organizations/${organization.id}/roles`) return { profiles: [], canCreate: false };
    if (p === `/api/organizations/${organization.id}/payments/providers`) return { providers: [] };
    if (p.endsWith('/defaults')) return { effective: {}, inherited: {} };
    if (p === `/api/projects/${project.id}/tasks`) return tasks;
    if (p === `/api/projects/${project.id}/search`) return { tasks, total: tasks.length };
    if (p === '/api/search') return { tasks, total: tasks.length, offset: 0, limit: 200, tags: [], projects: [{ id: project.id, name: project.name, organizationId: project.organizationId }] };
    if (byId(p)) return taskView(byId(p));
    if (p.endsWith('/sessions')) return {};
    const attempts = tasks.find((task) => p === `/api/tasks/${task.id}/attempts`);
    if (attempts) return { principalAttemptId: attempts.id, attempts: [attempts] };
    return [];
  };
  await context.routeWebSocket('**/ws*', (ws) => { sockets.push(ws); });
  await context.route(`${origin}/**`, async (route) => {
    const request = route.request(), url = new URL(request.url()), p = url.pathname;
    if (!p.startsWith('/api/')) {
      const file = ASSETS.has(p) ? p.slice(1) : 'index.html';
      return route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html',
        body: fs.readFileSync(path.join(WEB, file), 'utf8') });
    }
    requests.push(`${request.method()} ${p}`);
    let data = await api(p, request, url);
    if (data === undefined) data = defaults(p);
    return data?.[REPLY] ? route.fulfill({ status: data.status, json: data.json }) : route.fulfill({ json: data });
  });
  return { requests, sockets };
}

module.exports = { fakeConsole, launch, reply, taskView };
