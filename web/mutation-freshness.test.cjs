// Regression checks for mutations whose server-side success/failure must be
// reflected immediately in the browser's local projection.
// Run: node web/mutation-freshness.test.cjs
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

function extractFn(name) {
  const asyncStart = src.indexOf(`async function ${name}(`);
  const syncStart = src.indexOf(`function ${name}(`);
  const start = asyncStart >= 0 ? asyncStart : syncStart;
  if (start < 0) return null;
  let depth = 0;
  const open = src.indexOf('{', start);
  for (let index = open; index < src.length; index++) {
    if (src[index] === '{') depth++;
    else if (src[index] === '}' && --depth === 0) return src.slice(start, index + 1);
  }
  return null;
}

let passed = 0;
let failed = 0;
function ok(condition, message) {
  if (condition) passed++;
  else { failed++; console.error('FAIL:', message); }
}
function load(name) {
  const body = extractFn(name);
  ok(!!body, `${name} exists`);
  if (body) (0, eval)(body);
  return !!body;
}

global.esc = (value) => String(value ?? '');
global.authorizationSummary = (value) => value.level;
global.S = {
  tasks: [], searchResult: null, deleted: new Set(), cancelling: new Set(),
  inbox: [], view: null, selected: null,
};

if (load('filterDeletedFromSearchResult') && load('removeDeletedTaskLocally')) {
  const draft = { id: 'draft-1', lastView: {} };
  const keep = { id: 'task-2', lastView: {} };
  S.tasks = [draft, keep];
  S.searchResult = {
    tasks: [draft, keep], total: 2,
    groups: [{ key: 'all', count: 2, tasks: [draft, keep] }],
  };
  removeDeletedTaskLocally(draft.id);
  ok(!S.tasks.some((task) => task.id === draft.id), 'a programmatically deleted draft leaves the task pool');
  ok(!S.searchResult.tasks.some((task) => task.id === draft.id), 'a programmatically deleted draft leaves the visible result');
}

let bellUpdates = 0;
global.updateBell = () => { bellUpdates++; };
if (load('markInboxItemReadLocally')) {
  const item = { id: 'inbox-1', unread: true };
  S.inbox = [item];
  markInboxItemReadLocally(item);
  ok(item.unread === false, 'opening an inbox item updates its local unread state');
  ok(bellUpdates === 1, 'opening an inbox item updates the bell immediately');
}

if (load('pendingCancellationView') && load('pendingCancellationTask') && load('markTaskCancelling')) {
  const listView = { taskId: 'task-1', stage: 'do', status: 'active', actions: [{ name: 'cancel', enabled: true }] };
  const pageView = { ...listView, actions: listView.actions.map((action) => ({ ...action })) };
  S.tasks = [{ id: 'task-1', lastView: listView }];
  S.searchResult = { tasks: [{ id: 'task-1', lastView: { ...listView } }], total: 1 };
  S.view = pageView;
  S.selected = 'task-1';
  markTaskCancelling('task-1');
  ok(S.view.waitingFor?.detail === 'Waiting for cancellation', 'the open task immediately shows cancellation in progress');
  ok(S.tasks[0].lastView.waitingFor?.detail === 'Waiting for cancellation', 'the task-list row immediately shows cancellation in progress');
  ok(S.view.actions.every((action) => !action.enabled), 'task actions are disabled while cancellation settles');
  const terminal = pendingCancellationView({ taskId: 'task-1', stage: 'cancelled', status: 'cancelled' }, 'task-1');
  ok(terminal.status === 'cancelled' && !S.cancelling.has('task-1'), 'the durable terminal view retires the cancellation overlay');
}

let pendingBox;
global.$ = (selector) => selector === '#pending-invitations' ? pendingBox : null;
if (load('pendingInvitationRow') && load('appendPendingInvitation')) {
  pendingBox = {
    hidden: true,
    html: '',
    querySelector: () => null,
    insertAdjacentHTML(_where, html) { this.html += html; },
  };
  appendPendingInvitation({ id: 'invite-1', email: 'friend@example.com', authorization: { level: 'developer', scope: 'organization' } }, []);
  ok(!pendingBox.hidden && pendingBox.html.includes('friend@example.com'), 'a new invitation appears in Pending invitations immediately');
}

global.api = async () => [{ id: 'holder-1', name: 'A Person', type: 'individual', status: 'active', requirements: {} }];
if (load('syncPaymentProviderControls')) {
  const holder = { innerHTML: '' };
  const states = { holder: null, issue: null };
  const box = { querySelector(selector) {
    if (selector === '.card-cardholder') return holder;
    if (selector === '.pay-cardholder') return { classList: { toggle(_name, hidden) { states.holder = hidden; } } };
    if (selector === '.stripe-issue') return { classList: { toggle(_name, hidden) { states.issue = hidden; } } };
    return null;
  } };
  (async () => {
    await syncPaymentProviderControls(box, { providers: [{ name: 'stripe', connected: true }] }, '/api/payments');
    ok(states.holder === false && states.issue === false, 'Stripe controls appear immediately after connecting');
    ok(holder.innerHTML.includes('A Person'), 'Stripe cardholders load immediately after connecting');
    await syncPaymentProviderControls(box, { providers: [{ name: 'stripe', connected: false }] }, '/api/payments');
    ok(states.holder === true && states.issue === true, 'Stripe controls hide immediately after disconnecting');
    finish();
  })().catch((error) => { console.error(error); failed++; finish(); });
} else finish();

function finish() {
  ok(src.includes("await api(`/api/tasks/${draftId}/workflow`") && src.includes("method: 'PATCH'"),
    'workflow switching updates its auto-draft in place');
  ok(src.includes('appendPendingInvitation(result.invitation, authorizationProjects);'), 'inviting a member updates Pending invitations');
  ok(src.includes("e.target.value = String(rec.params?.priority || 0)"), 'a rejected priority change restores the saved value');
  ok(src.includes('sel.value = sel.dataset.saved'), 'a rejected workflow pin restores the saved value');
  ok(src.includes('e.target.checked = S.meta.safeMode'), 'a rejected safe-mode change restores the saved value');
  ok(src.includes("const editor = row.querySelector('.authz-editor')") && src.includes('toast(e.message, true); await hydrateOrganizationView();'), 'a rejected member authorization change reloads the durable value');
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
