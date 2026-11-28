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
const ASSETS = new Set(['/app.js', '/styles.css', '/markdown.js', '/file-view.js', '/offline-files.js', '/site.js', '/totp-qr.js', '/register-service-worker.js', '/vendor/highlight.min.js']);
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
      // The public pages fetch their Markdown from files beside the console (docs, comparisons, About, the changelog).
      const doc = /^\/(?:(?:docs|compare)\/)?[a-z-]+\.md$/.test(p) && fs.existsSync(path.join(WEB, p)) ? p.slice(1) : null;
      const file = doc || (ASSETS.has(p) ? p.slice(1) : 'index.html');
      if (p.endsWith('.md') && !doc) return route.fulfill({ status: 404, body: 'not found' });
      return route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.md') ? 'text/markdown' : 'text/html',
        body: fs.readFileSync(path.join(WEB, file), 'utf8') });
    }
    requests.push(`${request.method()} ${p}`);
    let data = await api(p, request, url);
    if (data === undefined) data = defaults(p);
    return data?.[REPLY] ? route.fulfill({ status: data.status, json: data.json }) : route.fulfill({ json: data });
  });
  return { requests, sockets };
}

/**
 * Answers `GET /api/tasks/<taskId>` and `/transcript` as the gateway does for
 * a page that reads a window of a conversation (src/platform/conversation-window.ts):
 * the newest ?messages=N, nothing of them while &known names the current
 * revision, earlier ones by index. `current()` returns the task's full view.
 * Undefined for any other request.
 */
function conversationWindowApi(taskId, current) {
  return (p, url) => {
    const view = current();
    const messages = view.messages || [];
    if (p === `/api/tasks/${taskId}`) {
      const size = Number(url.searchParams.get('messages'));
      if (!size) return view;
      const from = Math.max(0, messages.length - size);
      const window = messages.slice(from);
      const revision = `${size}:${messages.length}:${JSON.stringify(window).length}`;
      const { messages: _messages, transcripts, ...status } = view;
      const conversationWindow = { revision, roles: { do: { from, total: messages.length } } };
      if (url.searchParams.get('known') === revision) return { ...status, conversationWindow: { ...conversationWindow, unchanged: true } };
      return { ...status, messages: window, ...(transcripts ? { transcripts: transcripts.map(({ role, label }) => ({ role, label, sameAsMessages: true })) } : {}), conversationWindow };
    }
    if (p === `/api/tasks/${taskId}/transcript`) {
      const before = Math.min(Number(url.searchParams.get('before')), messages.length);
      const from = Math.max(0, before - Number(url.searchParams.get('limit')));
      return { role: 'do', from, total: messages.length, messages: messages.slice(from, before) };
    }
    return undefined;
  };
}

module.exports = { conversationWindowApi, fakeConsole, launch, reply, taskView };
