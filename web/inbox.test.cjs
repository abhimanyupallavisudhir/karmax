// The bell: its badge counts new asks in every organization, and its page (the
// Home list over every organization) heads For me with asks that are not tasks.
// Run: node web/inbox.test.cjs
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

function extractFn(name) {
  const start = src.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  if (start < 0) throw new Error(`${name} not found`);
  let parens = 0;
  let open = -1;
  for (let i = src.indexOf('(', start); i < src.length; i++) {
    if (src[i] === '(') parens++;
    else if (src[i] === ')') parens--;
    else if (src[i] === '{' && parens === 0) { open = i; break; }
  }
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}
function extractConst(name) {
  const start = src.search(new RegExp(`^const ${name} = `, 'm'));
  if (start < 0) throw new Error(`${name} not found`);
  const end = src.indexOf('\n];', start);
  return src.slice(start, end + 3);
}

global.esc = (value) => String(value ?? '').replace(/[&<>"]/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
})[char]);
global.S = { inbox: [], tab: 'inbox', search: 'for:me', organizations: [{ id: 'o1', name: 'Acme & Co', slug: 'acme' }],
  projects: [{ id: 'project_1', organizationId: 'o1', name: 'Karmax & tools' }] };
global.syncNotificationAlerts = () => {}; // alert overlays: web/notification-alerts.browser.test.cjs
global.FOR_ME_VIEW = '__for_me__';
global.viewIdForQuery = (q) => (q === 'for:me' ? FOR_ME_VIEW : null);
global.organizationById = (id) => S.organizations.find((o) => o.id === id);
global.projectById = (id) => S.projects.find((p) => p.id === id);
global.formatBytes = (n) => `${n} B`;

eval(extractConst('URGENCY_LEVELS').replace('const URGENCY_LEVELS =', 'global.URGENCY_LEVELS ='));
for (const name of ['urgencyRank', 'inboxUnreadCount', 'taskHasUnreadAsk', 'inboxRowLabel', 'inboxTitle', 'urgencyChip', 'updateBell',
  'inboxNotices', 'inboxNoticesHtml', 'slugify', 'projectSlug', 'projectPath', 'orgSlug', 'projectLabel']) eval(extractFn(name));

let pass = 0;
let fail = 0;
const ok = (condition, message) => condition ? pass++ : (fail++, console.error('FAIL:', message));

const item = (id, kind, unread, extra = {}) => ({ id, kind, unread, actionable: kind !== 'update', urgency: 'normal', organizationId: 'o1',
  taskId: `task_${id}`, createdAt: 1_700_000_000_000, task: { id: `task_${id}`, num: Number(id), title: `Task ${id}`, projectId: 'project_1' }, ...extra });

S.inbox = [
  item('1', 'approval-requested', true),
  item('2', 'review-requested', true, { organizationId: 'o2' }),
  item('3', 'review-requested', false),
  item('4', 'update', true),
];
// The badge: unread asks in every organization, never routine updates.
const badge = { classList: { toggle() {} } };
global.$ = (selector) => selector === '#bell-badge' ? badge : null;
updateBell();
ok(badge.textContent === 2, `the bell counts unread asks across organizations (got ${badge.textContent})`);
ok(taskHasUnreadAsk('task_1') && !taskHasUnreadAsk('task_3'), 'a row knows whether its ask is new');
ok(!taskHasUnreadAsk('task_4'), 'an unread update does not mark its row');

// An update's news is the outcome, not the word "update".
ok(inboxRowLabel(item('9', 'update', true, { task: { status: 'cancelled' } })) === 'cancelled', 'an update row names the outcome it reports');
ok(inboxRowLabel(item('9', 'review-requested', true)) === 'review requested', 'an ask names itself');

// Every priority is explicit and ranked.
ok(urgencyRank('critical') > urgencyRank('high') && urgencyRank('high') > urgencyRank('normal')
  && urgencyRank('normal') > urgencyRank('low'), 'the levels rank in order');
ok(urgencyRank('nonsense') === urgencyRank('normal'), 'an unknown level reads as normal, not as the floor');
ok(urgencyChip('low').includes('low priority'), 'low priority has an accessible label');
ok(urgencyChip('invalid').includes('normal priority'), 'unknown priority safely defaults to normal');

// Asks that are not a task's head For me, most urgent first.
const notice = (id, extra) => ({ id, kind: 'approval-requested', unread: true, actionable: true, urgency: 'normal', organizationId: 'o1', createdAt: 1, ...extra });
S.inbox = [
  item('1', 'review-requested', true),
  notice('cred', { subject: { kind: 'credential', provider: 'claude', account: 'ops', reason: 'signed-out' } }),
  notice('avatar', { urgency: 'critical', subject: { kind: 'avatar-authorization', projectId: 'project_1' }, resource: { name: 'Design <helper>', projectId: 'project_1' } }),
  notice('old', { actionable: false, subject: { kind: 'credential', provider: 'x', account: 'y', reason: 'signed-out' } }),
];
ok(inboxNotices().map((x) => x.id).join(',') === 'avatar,cred', `only live asks without a task, urgency first (got ${inboxNotices().map((x) => x.id)})`);
const html = inboxNoticesHtml();
ok(/class="task-row inbox-row unread" data-inbox="avatar" tabindex="0"/.test(html), 'a notice is a focusable task row');
ok(html.includes('Avatar authorization approval') && html.includes('Design &lt;helper&gt;'), 'it says what is asked, escaped');
ok(html.includes('<span class="task-project-org">acme/</span>karmax-tools'), 'it names organization and project as a slug');
ok(/<span class="task-project" title="Acme &amp; Co"><span class="task-project-org">acme<\/span><\/span>/.test(html), 'an organization-wide ask names just its organization');
ok(html.indexOf('data-inbox="avatar"') < html.indexOf('data-inbox="cred"'), 'the critical notice comes first');
S.search = '';
ok(inboxNoticesHtml() === '', 'notices belong to For me');
S.search = 'for:me'; S.tab = 'home';
ok(inboxNoticesHtml() === '', 'and to the bell\'s page only');

for (const name of ['taskRow', 'seriesRow']) ok(!extractFn(name).includes('workflowLabel('), name + ' omits workflow type');

const openItem = extractFn('openInboxItem');
ok(!openItem.includes('await loadTasks'), 'opening an inbox task does not preload its project before navigation');
ok(openItem.indexOf('markInboxItemReadLocally(item)') < openItem.indexOf('return go('),
  'opening an inbox task updates bookkeeping locally and navigates immediately');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
