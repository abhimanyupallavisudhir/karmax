// A console for comparing project icons and task status styles
// (design/project-icon-status/shoot.cjs): several projects, two in a folder,
// and one list holding every status a row can show (working, landing, review,
// needs input, waiting on a job or quota, failed, done, draft) with tags,
// priorities and For me asks. On the fake gateway (tests/helpers/fake-console.cjs).
const fs = require('node:fs');
const path = require('node:path');
const { fakeConsole } = require('../../tests/helpers/fake-console.cjs');

const NOW = Date.now();
const projects = [
  { id: 'p', organizationId: 'o', name: 'Website', slug: 'website', config: {} },
  { id: 'q', organizationId: 'o', name: 'Mobile app', slug: 'mobile-app', config: {} },
  { id: 'r', organizationId: 'o', name: 'Billing', slug: 'billing', folder: 'Platform', config: {} },
  { id: 's', organizationId: 'o', name: 'Search', slug: 'search', folder: 'Platform', config: {} },
  { id: 'u', organizationId: 'o', name: 'Hiring', slug: 'hiring', config: {} },
];
const tags = [
  { id: 'g1', name: 'bug', kind: 'type', color: '#d1453b' },
  { id: 'g2', name: 'checkout', kind: 'topic', color: '#2f80ed' },
  { id: 'g3', name: 'design', kind: 'topic', color: '#9b51e0' },
  { id: 'g4', name: 'blocked', kind: 'flag', color: '#e8962a' },
];
const H = 3_600_000;
const task = (n, title, lastView, extra = {}) => ({ id: `t${n}`, projectId: 'p', num: n, title, workflow: 'software-dev', params: {}, tags: [],
  createdAt: NOW - n * 20 * 60_000, updatedAt: NOW - n * 9 * 60_000, lastView: { updatedAt: NOW - n * 9 * 60_000, ...lastView }, ...extra });
const tasks = [
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
const reasons = { t41: ['review-requested'], t40: ['escalated'], t39: ['approval-requested'] };
const stages = [
  { key: 'setup', label: 'Setup' }, { key: 'do', label: 'Do' }, { key: 'review', label: 'Review' },
  { key: 'merge', label: 'Merge', ponr: true }, { key: 'done', label: 'Done' },
];

async function statusConsole(context) {
  await fakeConsole(context, { project: projects[0], tasks, schema: [{ name: 'software-dev', stages }], async api(p, req, url) {
    if (p === '/api/projects') return projects;
    const project = projects.find((x) => p === `/api/projects/${x.id}`);
    if (project) return project;
    if (/^\/api\/projects\/[a-z]\/tags$/.test(p)) return tags;
    if (/^\/api\/projects\/[a-z]\/search$/.test(p) || /^\/api\/(organizations\/o\/search|search)$/.test(p)) {
      const q = url.searchParams.get('q') || '';
      const forMe = /(^|\s)for:me\b/.test(q);
      const listed = tasks.filter((t) => !forMe || reasons[t.id]);
      if (url.searchParams.get('countBy')) return { total: 3, counts: { p: 3, q: 1 } };
      return { tasks: listed, total: listed.length, offset: 0, limit: 200, tags,
        projects: projects.map((x) => ({ id: x.id, name: x.name, slug: x.slug, organizationId: 'o' })),
        ...(forMe ? { reasons: Object.fromEntries(listed.map((t) => [t.id, reasons[t.id]])) } : {}) };
    }
    if (p === '/api/settings/installation') return { canManage: true, siteName: 'tavya' };
    if (p === '/api/inbox') return [];
    return undefined;
  } });
  await context.route('http://console.test/fonts/**', (route) => route.fulfill({ body: fs.readFileSync(path.join(__dirname, '../../web', new URL(route.request().url()).pathname)) }));
}

module.exports = { statusConsole, tasks, projects };
