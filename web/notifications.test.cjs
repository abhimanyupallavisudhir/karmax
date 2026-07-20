// Focused checks for the notification inbox's state semantics and rendering.
// Run: node web/notifications.test.cjs
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

function extractFn(name) {
  const markers = [`function ${name}(`, `async function ${name}(`];
  const start = markers.map((m) => src.indexOf(m)).find((i) => i >= 0);
  if (start === undefined) throw new Error(`${name} not found`);
  let depth = 0;
  const brace = src.indexOf('{', start);
  for (let i = brace; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

global.S = { attentionLoaded: true, attentionLoading: false, attentionFilter: 'all', attention: [], tasks: [], projects: [] };
global.TASK_TABS = [];
global.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
global.projectById = () => null;
global.fmtAgo = () => '5m ago';

for (const fn of ['parseRoute', 'isAttentionTask', 'needsAttention', 'attentionCopy', 'attentionItem', 'notificationsView']) eval(extractFn(fn));

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error('FAIL:', msg); } };
const task = (id, stage, extra = {}) => ({
  id,
  num: id === 'blocked' ? 7 : 8,
  title: id === 'blocked' ? 'Fix deployment' : 'Polish settings',
  projectId: 'p1',
  projectName: 'Console',
  workflow: 'software-dev',
  createdAt: 100,
  params: {},
  lastView: { stage, status: stage === 'escalated' ? 'blocked' : 'waiting', updatedAt: 200, ...extra },
});

const blocked = task('blocked', 'escalated', { error: 'Deploy key expired' });
const review = task('review', 'review', { reviewInfo: { caption: 'Verify the responsive layout.' } });

ok(parseRoute('/notifications').tab === 'notifications', 'notifications has a first-class global route');
ok(isAttentionTask(blocked), 'escalated top-level task needs attention');
ok(isAttentionTask(review), 'review task needs attention');
ok(!isAttentionTask({ ...review, parentTaskId: 'parent' }), 'sub-tasks stay out of the human inbox');
ok(!isAttentionTask({ ...review, params: { archived: true } }), 'archived tasks stay out of the inbox');
ok(!isAttentionTask({ ...review, lastView: { ...review.lastView, status: 'done' } }), 'resolved tasks leave the inbox');
ok(!isAttentionTask({ ...review, lastView: { ...review.lastView, status: 'cancelled' } }), 'cancelled tasks invalidate a stale review notification');
ok(!isAttentionTask({ ...review, lastView: { ...review.lastView, status: 'failed' } }), 'failed tasks invalidate a stale review notification');
ok(attentionCopy(blocked) === 'Deploy key expired', 'blockers surface the actionable error');
ok(attentionCopy(review) === 'Verify the responsive layout.', 'reviews surface their verification caption');

S.attention = [blocked, review];
let html = notificationsView();
ok(html.includes('Needs direction</span><b>1</b>'), 'blocked count is visible');
ok(html.includes('Ready for review</span><b>1</b>'), 'review count is visible');
ok(html.includes('Console') && html.includes('#7'), 'items carry project and human task context');
ok(html.indexOf('Fix deployment') < html.indexOf('Polish settings'), 'the supplied priority order is preserved');

S.attentionFilter = 'review';
html = notificationsView();
ok(html.includes('Polish settings') && !html.includes('Fix deployment'), 'type filters narrow the visible inbox');

S.attention = [];
S.attentionFilter = 'all';
html = notificationsView();
ok(html.includes('You’re all caught up'), 'empty state explains that no action is needed');

S.attentionError = 'Could not load notifications.';
html = notificationsView();
ok(html.includes('Notifications are unavailable') && !html.includes('You’re all caught up'), 'a load failure is not mistaken for an empty inbox');

// If a task changes while an inbox query is in flight, the pending result can be
// older than that transition. loadAttention must remember the invalidation and
// immediately re-query instead of leaving the stale review card visible.
global.attentionPromise = null;
global.attentionReloadQueued = false;
global.updateBell = () => {};
global.renderRail = () => {};
global.renderMain = () => {};
let resolveFirst;
let apiCalls = 0;
global.api = () => {
  apiCalls++;
  if (apiCalls === 1) return new Promise((resolve) => { resolveFirst = resolve; });
  return Promise.resolve({ tasks: [] }); // the task advanced before the second read
};
eval(extractFn('loadAttention'));

(async () => {
  S.projects = [{ id: 'p1', name: 'Console' }];
  S.tab = 'tasks';
  S.attention = [];
  S.attentionLoaded = false;
  S.attentionError = null;
  const first = loadAttention();
  loadAttention(); // queues a follow-up while the first read is pending
  resolveFirst({ tasks: [review] });
  await first;
  await new Promise((resolve) => setTimeout(resolve, 20));
  ok(apiCalls === 2, 'a state change during refresh forces a second current-state read');
  ok(S.attention.length === 0, 'the newer read removes the outdated review notification');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
