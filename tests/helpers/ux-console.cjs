// A realistic console for usability checks (design/ux-round-2/shoot.cjs and
// web/accessibility.browser.test.cjs): two projects; For me rows that ask for a
// review, a credential, a permission and a one-click answer; a task with a
// credential request; Insights; settings. On the fake gateway (fake-console.cjs).
const fs = require('node:fs');
const path = require('node:path');
const { fakeConsole, taskView } = require('./fake-console.cjs');

const NOW = Date.now();
const fence = (spec) => `\`\`\`form\n${JSON.stringify(spec)}\n\`\`\``;
const question = `Which database should orders live in?\n\n${fence({ options: ['Postgres', 'SQLite'] })}`;
const project = { id: 'p', organizationId: 'o', name: 'Website', config: {} };
const mobile = { id: 'q', organizationId: 'o', name: 'Mobile App', config: {} };
const slug = { p: 'website', q: 'mobile-app' };
const task = (n, projectId, title, lastView) => ({ id: `t${n}`, projectId, num: n, title, workflow: 'software-dev', params: {}, tags: [], createdAt: NOW - n * 60_000, lastView });
const tasks = [
  task(1, 'p', 'Checkout keeps the cart when you sign in', { stage: 'review', status: 'waiting', waitingFor: { kind: 'human' } }),
  task(2, 'p', 'Update prices on the shop', { stage: 'do', status: 'waiting', waitingFor: { kind: 'human', reason: 'approval' }, pendingDecisions: 1 }),
  task(3, 'q', 'Store orders offline', { stage: 'do', status: 'waiting', waitingFor: { kind: 'human', detail: question },
    lastMessage: { role: 'agent', text: question, ts: NOW - 120_000 } }),
  task(4, 'q', 'Weekly analytics report', { stage: 'do', status: 'waiting', waitingFor: { kind: 'human', reason: 'approval' }, pendingDecisions: 1 }),
  task(5, 'p', 'Offline mode for the reading list', { stage: 'do', status: 'active' }),
];
const reasons = { t1: ['review-requested'], t2: ['approval-requested'], t3: ['escalated'], t4: ['approval-requested'] };
const credentialRequest = { id: 'vr1', taskId: 't2', status: 'pending', itemId: 'vi1', mode: 'use', kind: 'use', why: 'Updating the prices needs the shop admin.', createdAt: NOW - 300_000,
  task: { id: 't2', num: 2, title: tasks[1].title, projectId: 'p' } };
const permissionRequest = { id: 'pr1', taskId: 't4', status: 'pending', role: 'do', capabilities: ['project:read'], projectIds: ['p'], audience: ['@owners'],
  reason: 'The report reads the shop’s orders.', createdAt: NOW - 200_000, task: { id: 't4', num: 4, title: tasks[3].title, projectId: 'q' } };
const day = (i) => new Date(NOW - (6 - i) * 86_400_000).toISOString().slice(0, 10);
const insights = { days: 7, from: NOW - 6 * 86_400_000, to: NOW, utcOffsetMinutes: 0,
  totals: { shipped: 11, created: 16, turns: 21, meteredTurns: 21, failedTurns: 2, agentSeconds: 100_800, tokens: 28_000, inputTokens: 24_000, outputTokens: 4_000, medianShipMs: 3 * 3_600_000 },
  previous: { shipped: 8, created: 16, turns: 10, failedTurns: 0, agentSeconds: 50_000, tokens: 20_000, inputTokens: 1, outputTokens: 1, medianShipMs: 4 * 3_600_000 },
  daily: Array.from({ length: 7 }, (_, i) => ({ day: day(i), shipped: [1, 0, 2, 3, 0, 1, 4][i], created: [2, 1, 3, 2, 1, 2, 5][i], turns: 3, agentSeconds: 3600 * (i + 1), tokens: 1000 * (i + 1), tokensByModel: {} })),
  models: [{ model: 'opus', provider: 'anthropic', turns: 21, meteredTurns: 21, failedTurns: 2, agentSeconds: 100_800, tokens: 28_000 }],
  projects: [{ id: 'p', name: 'Website', shipped: 7, open: 3, turns: 12, agentSeconds: 60_000, tokens: 18_000, daily: [1, 0, 1, 2, 0, 1, 2] },
    { id: 'q', name: 'Mobile App', shipped: 4, open: 2, turns: 9, agentSeconds: 40_800, tokens: 10_000, daily: [0, 0, 1, 1, 0, 0, 2] }],
  pipeline: { stages: { do: { open: 3, working: 1, waiting: 2 }, review: { open: 1, working: 0, waiting: 1 } }, working: 1, waiting: 3, drafts: 1 },
  working: [{ taskId: 't5', num: 5, title: tasks[4].title, projectId: 'p', stage: 'do' }],
  waiting: tasks.slice(0, 4).map((t) => ({ taskId: t.id, num: t.num, title: t.title, projectId: t.projectId, stage: t.lastView.stage })), recent: [] };


/** Serve that console in `context` (the Inter font included). */
async function uxConsole(context) {
  await fakeConsole(context, { project, tasks, async api(p, req, url) {
      const method = req.method();
      if (p === '/api/projects') return [project, mobile];
      if (p === '/api/projects/q') return mobile;
      if (p === '/api/projects/q/tasks') return tasks.filter((t) => t.projectId === 'q');
      if (p === '/api/projects/q/search' || p === '/api/projects/p/search') {
        const q = url.searchParams.get('q') || '', id = p.split('/')[3];
        const listed = tasks.filter((t) => t.projectId === id && (!/(^|\s)for:me\b/.test(q) || reasons[t.id]));
        return { tasks: listed, total: listed.length, ...(/for:me/.test(q) ? { reasons: Object.fromEntries(listed.map((t) => [t.id, reasons[t.id]])) } : {}) };
      }
      if (p === '/api/settings/installation') return { canManage: true, siteName: 'tavya' };
      if (p === '/api/settings/global/appearance') return { icon: 'diamond' };
      if (p === '/api/user/app-grants') return { grants: [], levels: [] };
      if (p === '/api/organizations/o/insights') return insights;
      if (/^\/api\/(organizations\/o\/search|search)$/.test(p)) {
        const q = url.searchParams.get('q') || '';
        const forMe = /(^|\s)for:me\b/.test(q);
        const listed = tasks.filter((t) => !forMe || reasons[t.id]);
        if (url.searchParams.get('countBy')) return { total: listed.length, counts: Object.fromEntries(['p', 'q'].map((id) => [id, listed.filter((t) => t.projectId === id).length])) };
        return { tasks: listed, total: listed.length, offset: 0, limit: 200, tags: [],
          projects: [project, mobile].map((x) => ({ id: x.id, name: x.name, slug: slug[x.id], organizationId: 'o' })),
          ...(forMe ? { reasons: Object.fromEntries(listed.map((t) => [t.id, reasons[t.id]])), updated: Object.fromEntries(listed.map((t) => [t.id, t.createdAt])) } : {}) };
      }
      if (p === '/api/inbox' && method === 'GET') return tasks.slice(0, 4).map((t, i) => ({ id: `i${i}`, organizationId: 'o', kind: reasons[t.id][0], unread: i < 2, actionable: true,
        urgency: 'normal', createdAt: t.createdAt, taskId: t.id, task: { id: t.id, num: t.num, title: t.title, projectId: t.projectId, status: 'waiting' } }));
      if (p === '/api/vault/requests') return url.searchParams.get('taskId') && url.searchParams.get('taskId') !== 't2' ? [] : [credentialRequest];
      if (p === '/api/vault/items') return [{ id: 'vi1', label: 'Shop admin', type: 'login', domains: ['shop.example'] }];
      if (p === '/api/permission-requests') return url.searchParams.get('taskId') && url.searchParams.get('taskId') !== 't4' ? [] : [permissionRequest];
      if (p === '/api/authorization-requests' || p === '/api/repository-access-requests') return [];
      if (p === '/api/tasks/t2') return taskView(tasks[1], { stage: 'do', status: 'waiting', waitingFor: { kind: 'human', reason: 'approval' }, approvalRequests: 1, pendingDecisions: 1,
        actions: [{ name: 'followUp', label: 'Send', enabled: true }],
        messages: [{ id: 'm0', role: 'user', author: 'user:u', text: 'Raise every price by 5%.', ts: NOW - 600_000 },
          { id: 'a1', role: 'agent', text: 'I need the shop admin to change the prices.', ts: NOW - 300_000 }] });
      if (p === '/api/tasks/t3') return taskView(tasks[2], { stage: 'do', status: 'waiting', waitingFor: { kind: 'human', detail: question },
        actions: [{ name: 'followUp', label: 'Send', enabled: true }],
        messages: [{ id: 'm0', role: 'user', author: 'user:u', text: 'Store orders so the app works offline.', ts: NOW - 600_000 }, { id: 'a1', role: 'agent', text: question, ts: NOW - 120_000 }] });
      if (p.endsWith('/events')) return [];
      return undefined;
    } });
  await context.route('http://console.test/fonts/**', (route) => route.fulfill({ body: fs.readFileSync(path.join(__dirname, '../../web', new URL(route.request().url()).pathname)) }));
}

module.exports = { uxConsole, tasks };
