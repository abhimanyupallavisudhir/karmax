// A project's task list with a row of every kind (web/task-list-layout.browser.test.cjs,
// design/task-list/shoot.cjs): every status (working, landing, review, needs
// input, waiting on a job or quota, failed, done, cancelled, draft) with tags,
// priorities and For me asks, a repeatable series with runs, a task waiting
// for its trigger, and server-side grouping (group:stage). On the fake gateway.
const fs = require('node:fs');
const path = require('node:path');
const { fakeConsole } = require('./fake-console.cjs');

const NOW = Date.now();
const H = 3_600_000;
const projects = [
  { id: 'p', organizationId: 'o', name: 'Website', slug: 'website', config: {} },
  { id: 'q', organizationId: 'o', name: 'Mobile app', slug: 'mobile-app', config: {} },
];
const task = (n, title, lastView, extra = {}) => ({ id: `t${n}`, projectId: 'p', num: n, title, workflow: 'software-dev', params: {}, tags: [],
  createdAt: NOW - n * 20 * 60_000, updatedAt: NOW - n * 9 * 60_000, lastView: { updatedAt: NOW - n * 9 * 60_000, ...lastView }, ...extra });
const statusTasks = [
  task(41, 'Checkout keeps the cart when you sign in', { stage: 'review', status: 'waiting', waitingFor: { kind: 'human' } }, { tags: ['g2'] }),
  task(40, 'Store orders offline', { stage: 'do', status: 'waiting', waitingFor: { kind: 'human' } }),
  task(39, 'Update prices on the shop', { stage: 'do', status: 'waiting', waitingFor: { kind: 'human', reason: 'approval' }, approvalRequests: 1 }, { params: { priority: 2 } }),
  task(38, 'Offline mode for the reading list', { stage: 'do', status: 'active' }, { tags: ['g3'] }),
  task(37, 'Fix the double charge on retries', { stage: 'merge', status: 'active' }, { tags: ['g1', 'g2'], params: { priority: 3 } }),
  task(36, 'Render the launch film', { stage: 'do', status: 'waiting', waitingFor: { kind: 'job', summary: 'render', until: NOW + 2 * H } }),
  task(35, 'Translate the docs into German', { stage: 'do', status: 'waiting', waitingFor: { kind: 'account', reason: 'quota', provider: 'claude', earliestResetAt: NOW + 3 * H } }),
  task(34, 'Migrate sessions to Redis', { stage: 'review', status: 'active' }, { tags: ['g4'] }),
  task(33, 'Nightly backup to R2', { stage: 'failed', status: 'failed' }),
  task(32, 'Dark mode for the settings page', { stage: 'done', status: 'done' }, { tags: ['g3'] }),
  task(31, 'Remove the old pricing page', { stage: 'cancelled', status: 'cancelled' }),
  task(30, 'Write the onboarding email series', {}, { params: { draft: true } }),
];
const tags = [
  { id: 'g1', name: 'bug', kind: 'type', color: '#d1453b' },
  { id: 'g2', name: 'checkout', kind: 'topic', color: '#2f80ed' },
  { id: 'g3', name: 'design', kind: 'topic', color: '#9b51e0' },
  { id: 'g4', name: 'blocked', kind: 'flag', color: '#e8962a' },
];
const extra = [
  { id: 't29', projectId: 'p', num: 29, title: 'Weekly dependency updates', workflow: 'software-dev', tags: [], createdAt: NOW - 30 * H, updatedAt: NOW - 2 * H,
    params: { repeatable: true, triggers: [{ kind: 'schedule', cron: '0 9 * * 1' }] }, lastView: { updatedAt: NOW - 2 * H } },
  { id: 'r1', projectId: 'p', title: 'Weekly dependency updates', workflow: 'software-dev', tags: [], createdAt: NOW - 2 * H, params: { runOf: 't29' },
    lastView: { stage: 'review', status: 'active', updatedAt: NOW - H } },
  { id: 'r2', projectId: 'p', title: 'Weekly dependency updates', workflow: 'software-dev', tags: [], createdAt: NOW - 170 * H, params: { runOf: 't29' },
    lastView: { stage: 'done', status: 'done', updatedAt: NOW - 160 * H } },
  { id: 't28', projectId: 'p', num: 28, title: 'Publish the release notes', workflow: 'software-dev', tags: [], createdAt: NOW - 31 * H, updatedAt: NOW - 3 * H,
    params: { triggerState: 'armed', triggers: [{ kind: 'dependency', tasks: ['t37'] }] }, lastView: { updatedAt: NOW - 3 * H } },
];
const tasks = [...statusTasks, ...extra];
const reasons = { t41: ['review-requested'], t40: ['escalated'], t39: ['approval-requested'] };
const stages = [
  { key: 'setup', label: 'Setup' }, { key: 'do', label: 'Do' }, { key: 'review', label: 'Review' },
  { key: 'merge', label: 'Merge', ponr: true }, { key: 'done', label: 'Done' },
];
const STAGE_GROUPS = [['do', 'Do'], ['review', 'Review'], ['merge', 'Landing'], ['done', 'Done'], ['failed', 'Failed'], ['cancelled', 'Cancelled'], ['setup', 'Draft']];

/** `taskList`: the installation's layout (Installation → Appearance → Task list), '' one line. */
async function listConsole(context, { taskList = '' } = {}) {
  await fakeConsole(context, { project: projects[0], tasks, schema: [{ name: 'software-dev', stages }], async api(p, req, url) {
    if (p === '/api/meta') return { siteName: 'Fixture', hostLocal: true, consoleRevision: 'one', agent: { provider: 'mock' }, worldProviders: [], taskList };
    if (p === '/api/projects') return projects;
    const project = projects.find((x) => p === `/api/projects/${x.id}`);
    if (project) return project;
    if (/^\/api\/projects\/[a-z]\/tags$/.test(p)) return tags;
    if (/^\/api\/projects\/[a-z]\/search$/.test(p) || /^\/api\/(organizations\/o\/search|search)$/.test(p)) {
      const q = url.searchParams.get('q') || '';
      const forMe = /(^|\s)for:me\b/.test(q);
      if (url.searchParams.get('countBy')) return { total: 3, counts: { p: 3, q: 1 } };
      const listed = tasks.filter((t) => (!forMe || reasons[t.id]) && !t.params.runOf);
      const groups = /group:stage/.test(q) ? STAGE_GROUPS.map(([key, label]) => ({ key, label,
        tasks: listed.filter((t) => (t.lastView?.stage || 'setup') === key) })).filter((g) => g.tasks.length) : undefined;
      return { tasks: listed, groups, total: listed.length, offset: 0, limit: 200, tags,
        projects: projects.map((x) => ({ id: x.id, name: x.name, slug: x.slug, organizationId: 'o' })),
        ...(forMe ? { reasons: Object.fromEntries(listed.map((t) => [t.id, reasons[t.id]])) } : {}) };
    }
    if (p === '/api/settings/installation') return { canManage: true, siteName: 'tavya' };
    if (p === '/api/inbox') return [];
    return undefined;
  } });
  await context.route('http://console.test/fonts/**', (route) => route.fulfill({ body: fs.readFileSync(path.join(__dirname, '../../web', new URL(route.request().url()).pathname)) }));
}

module.exports = { listConsole, tasks };
