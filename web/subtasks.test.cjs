// Focused checks for the task page's parent/child hierarchy. A parent shows useful
// delegated-work state (not opaque ids), and a child keeps a direct path home.
// Run: node web/subtasks.test.cjs
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
function extractFn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0;
  const open = src.indexOf('{', start);
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

global.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
global.S = {
  cancelling: new Set(),
  attemptGroup: null,
  attention: [],
  schema: [],
  tasks: [
    { id: 'parent', num: 10, title: 'Ship the new workspace', workflow: 'software-dev' },
    { id: 'child-a', num: 11, title: 'Polish navigation', workflow: 'software-dev', parentTaskId: 'parent', lastView: { stage: 'do', status: 'active' } },
    { id: 'child-b', num: 12, title: 'Verify keyboard access', workflow: 'software-dev', parentTaskId: 'parent', lastView: { stage: 'done', status: 'done' } },
    { id: 'child-c', num: 13, title: 'Resolve visual regression', workflow: 'software-dev', parentTaskId: 'parent', lastView: { stage: 'escalated', status: 'blocked' } },
  ],
};
global.pipeline = (v) => `<i class="test-pipeline">${esc(v.stage || 'setup')}</i>`;
global.PARKED_WAITS = new Set(['timer', 'job', 'subtask', 'collaboration', 'parent']);
global.waitDeadline = () => '4:00 PM';

// The real stage vocabulary, not a stub: a child must read exactly as it does in
// the task list and on its own page.
for (const name of ['taskRecord', 'numLabel', 'parentTaskContext', 'stageLabel', 'waitingLabel', 'waitingText', 'subTaskState', 'subTaskStateHtml', 'subTasksSection', 'patchLifecycleView', 'pendingCancellationView', 'patchSubTaskSummaryFromEvent', 'subTaskSummaryEventNeedsRefresh']) eval(extractFn(name));

let pass = 0, fail = 0;
const ok = (condition, message) => {
  if (condition) pass++;
  else { fail++; console.error('FAIL:', message); }
};

const parentLink = parentTaskContext({ taskId: 'child-a', parentTaskId: 'parent' });
ok(parentLink.includes('Sub-task of') && parentLink.includes('#10 Ship the new workspace'), 'child names its parent in the masthead');
ok(parentLink.includes('data-open="parent"') && parentLink.startsWith('<button'), 'parent context is one keyboard-operable navigation target');
ok(parentTaskContext({ taskId: 'parent' }) === '', 'top-level tasks do not render empty parent chrome');

ok(subTaskState(S.tasks[1]).label === 'working', 'active work reads as it does in the task list');
ok(subTaskState(S.tasks[2]).complete === true, 'done work contributes to completion');
ok(subTaskState(S.tasks[3]).label === 'escalated' && subTaskState(S.tasks[3]).tone === 'blocked', 'blocked work is called out');

// Faithfulness: every state a real child passes through (tasks #429, #456) gets
// the same label the task list gives it, never a second invented vocabulary that
// contradicts it ("Waiting · working", "Ready to return" for an approved child,
// "In progress" for a child that is landing or needs a person).
const state = (lastView, extra = {}) => subTaskState({ lastView, ...extra });
const cases = [
  [{ stage: 'do', status: 'waiting', waitingFor: { kind: 'agentSlot', detail: 'Starting agent' } }, 'working', 'waiting'],
  [{ stage: 'do', status: 'waiting', waitingFor: { kind: 'timer', until: 1 } }, 'Paused until 4:00 PM', 'waiting'],
  [{ stage: 'do', status: 'waiting', waitingFor: { kind: 'human', detail: 'Approve the sandbox keys' } }, 'Needs input', 'waiting'],
  [{ stage: 'do', status: 'waiting', waitingFor: { kind: 'subtask' } }, 'Waiting for sub-tasks', 'waiting'],
  [{ stage: 'review', status: 'waiting', waitingFor: { kind: 'parent' } }, 'review', 'waiting'],
  [{ stage: 'review', status: 'active' }, 'review', 'active'],
  [{ stage: 'merge', status: 'active' }, 'landing', 'active'],
  [{ stage: 'merge', status: 'waiting', waitingFor: { kind: 'github', detail: 'waiting for required checks' } }, 'landing', 'waiting'],
  [{ stage: 'done', status: 'done' }, 'done', 'done'],
  [{ stage: 'failed', status: 'failed' }, 'failed', 'failed'],
  [{ stage: 'cancelled', status: 'cancelled' }, 'cancelled', 'cancelled'],
  [{ stage: 'setup', status: 'active', state: { draft: true } }, 'draft', 'draft'],
];
for (const [view, label, tone] of cases) {
  const s = state(view);
  ok(s.label === label, `${JSON.stringify(view)} reads "${label}", got "${s.label}"`);
  ok(s.tone === tone, `${JSON.stringify(view)} has tone ${tone}, got ${s.tone}`);
}
ok(state({ stage: 'done', status: 'done' }).complete && !state({ stage: 'merge', status: 'active' }).complete, 'only finished work is complete');
ok(state({ stage: 'do', status: 'waiting', waitingFor: { kind: 'timer', until: 1 }, approvalRequests: 2 }).approval === true,
  'a child paused on an approval request says so, as the task list does');
ok(state({ stage: 'do', status: 'active' }).approval === false, 'no approval chip without a request');

const panel = subTasksSection({
  taskId: 'parent',
  workflow: 'software-dev',
  subTasks: ['child-a', 'child-b', 'child-c'],
});
ok(panel.includes('Polish navigation') && panel.includes('Verify keyboard access') && panel.includes('Resolve visual regression'), 'rows use human titles instead of only ids');
ok(panel.includes('<strong>1</strong> of 3 complete') && panel.includes('--subtask-progress:33%'), 'panel summarizes group progress');
ok((panel.match(/class="subtask-row"/g) || []).length === 3, 'every child is one large navigation row');
ok(!/In progress|Ready to return|Needs direction/.test(panel), 'no second state vocabulary beside the real one');
ok(panel.includes('>working<') && panel.includes('>escalated<'), 'each row carries its task-list label');
ok(panel.includes('aria-label="Open Polish navigation — working"'), 'the accessible name carries the same label');
ok(panel.includes('role="progressbar"') && panel.includes('aria-valuenow="1"'), 'completion is exposed to assistive technology');

// A finished child is archived out of the live task list, and a replaced parent
// run forgets children that had already settled. Neither may fall back to
// "setup" (task #367): the parent's view carries every child the
// store records, and a child's own events keep that summary current.
const summaries = {
  taskId: 'parent',
  workflow: 'software-dev',
  subTasks: ['child-a'],
  subTaskSummaries: [
    { id: 'child-a', num: 11, title: 'Polish navigation', workflow: 'software-dev', lastView: { stage: 'do', status: 'active' } },
    { id: 'archived-done', num: 14, title: 'Land the migration', workflow: 'software-dev', lastView: { stage: 'done', status: 'done' } },
    { id: 'settled-before-replacement', num: 15, title: 'Tenant isolation', workflow: 'software-dev', lastView: { stage: 'cancelled', status: 'cancelled' } },
  ],
};
const archived = subTasksSection(summaries);
ok((archived.match(/class="subtask-row"/g) || []).length === 3, 'children missing from the run and the live list still appear');
ok(archived.includes('Land the migration') && archived.includes('>done<') && archived.includes('test-pipeline">done'),
  'an archived child shows its real finished state, not setup');
ok(archived.includes('>cancelled<') && !archived.includes('test-pipeline">setup'), 'no child falls back to the setup placeholder');
ok(archived.includes('<strong>1</strong> of 3 complete'), 'archived children count towards completion');

// The parent's summary is the authority: a stale copy of the child elsewhere in
// the console (an old search result) must not override it.
S.searchResult = { tasks: [{ id: 'archived-done', num: 14, title: 'Land the migration', lastView: { stage: 'do', status: 'active' } }] };
ok(subTasksSection(summaries).includes('<strong>1</strong> of 3 complete'), 'the summary wins over a stale search-result copy');
S.searchResult = null;

const approval = subTasksSection({ taskId: 'parent', workflow: 'software-dev', subTaskSummaries: [
  { id: 'needs-key', num: 16, title: 'Paddle storage packs', workflow: 'software-dev',
    lastView: { stage: 'do', status: 'waiting', waitingFor: { kind: 'timer', until: 1 }, approvalRequests: 2 } },
] });
ok(approval.includes('Paused until 4:00 PM') && approval.includes('approval needed'), 'a child waiting on an approval shows it in the parent');

S.view = summaries;
ok(patchSubTaskSummaryFromEvent({ type: 'view.updated', taskId: 'child-a', payload: { stage: 'review', status: 'waiting', waitingFor: 'parent' } }) === true,
  "a child's event patches its summary in the open parent");
ok(summaries.subTaskSummaries[0].lastView.stage === 'review' && summaries.subTaskSummaries[0].lastView.waitingFor?.kind === 'parent',
  'the patched summary carries the new stage and wait');
ok(patchSubTaskSummaryFromEvent({ type: 'view.updated', taskId: 'child-a', payload: { stage: 'review', status: 'waiting', waitingFor: 'parent' } }) === false,
  'an unchanged event asks for no repaint');
ok(patchSubTaskSummaryFromEvent({ type: 'view.updated', taskId: 'unrelated', payload: { stage: 'done', status: 'done' } }) === false,
  'events of other tasks are ignored');

S.view = { taskId: 'parent', subTaskSummaries: [{ id: 'child-a' }] };
ok(subTaskSummaryEventNeedsRefresh({ type: 'credential.approval-requested', taskId: 'child-a' }) === true,
  "a child's approval request refreshes the open parent");
ok(subTaskSummaryEventNeedsRefresh({ type: 'permission.approval-resolved', taskId: 'child-a' }) === true,
  "a child's resolved approval refreshes the open parent");
ok(subTaskSummaryEventNeedsRefresh({ type: 'credential.approval-requested', taskId: 'unrelated' }) === false,
  'approvals of other tasks are ignored');
ok(subTaskSummaryEventNeedsRefresh({ type: 'view.updated', taskId: 'child-a' }) === false,
  'lifecycle events are patched in place, not refetched');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
