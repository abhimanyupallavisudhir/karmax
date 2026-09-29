// Regression coverage for the task-page attempt switcher. Attempts are selectable
// links (including the principal and drafts), with one unambiguous current marker.
// Run: node web/attempts.test.cjs
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
function extractFn(name) {
  let start = src.indexOf(`function ${name}(`);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0;
  // Find the function body's opening brace, not a destructured parameter's.
  const signatureEnd = src.indexOf(') {', start);
  const open = signatureEnd < 0 ? -1 : signatureEnd + 2;
  if (open < 0) throw new Error(`${name} signature not found`);
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

global.esc = (s) => String(s);
global.projectBase = () => '/org/project';
global.S = {
  tasks: [{ id: 'attempt-1', title: 'Task', projectId: 'p' }],
  taskTab: 'overview',
  attemptGroup: {
    principalAttemptId: 'attempt-1',
    attempts: [
      { id: 'attempt-1', attemptNumber: 1, params: {}, lastView: { stage: 'do', status: 'active', state: {}, stageTransitions: [{ target: 'human', label: 'Waiting for human input' }, { target: 'done', label: 'Done' }] } },
      { id: 'attempt-2', attemptNumber: 2, params: { draft: true }, lastView: { stage: 'setup', status: 'waiting', state: { draft: true }, stageTransitions: [{ target: 'do', label: 'Run task' }, { target: 'done', label: 'Done' }] } },
    ],
  },
};

eval(extractFn('taskRecord'));
eval(extractFn('stageLabel'));
eval(extractFn('stageIndicator'));
eval(extractFn('taskAttempts'));
eval(extractFn('addAttemptButton'));
global.workflowLabel = (workflow) => workflow;
global.priorityFlag = () => '';
global.tagChips = () => '';
global.pipeline = () => '';
eval(extractFn('customBranch'));
eval(extractFn('taskRow'));

let pass = 0, fail = 0;
const ok = (condition, message) => {
  if (condition) pass++;
  else { fail++; console.error('FAIL:', message); }
};

const html = taskAttempts({ taskId: 'attempt-2' });
ok((html.match(/data-attempt-select=/g) || []).length === 2, 'every attempt is a selectable row');
ok((html.match(/data-attempt-principal=/g) || []).length === 2, 'every attempt has a crown');
ok((html.match(/aria-pressed="true"/g) || []).length === 1, 'only the principal crown is pressed');
ok(!/<a[^>]*>[\s\S]*?<button/.test(html.split('</a>')[0]), 'crown is outside the navigation link');
ok(html.includes('data-attempt-select="attempt-1"'), 'principal can be selected again');
ok(html.includes('data-attempt-select="attempt-2"'), 'draft can be selected');
ok(html.includes('attempt-card selected') && html.includes('aria-current="true"'), 'current attempt is visibly and semantically selected');
ok(!html.includes('<details') && !html.includes('View full attempt'), 'switching needs no expansion or secondary action');
ok(!html.includes('data-stage-move='), 'attempt navigation has no nested stage mutation controls');
ok(html.includes('href="/org/project/tasks/attempt-2/overview"'), 'links pin the execution id and preserve the tab');
ok((html.match(/data-spa/g) || []).length === 2, 'attempts use native links and the shared router');
ok(html.includes('working') && html.includes('draft'), 'attempts show readable stage labels');
ok(taskRecord('attempt-2')?.params?.draft === true, 'task page resolves non-principal records from the attempt group');
global.projectById = () => ({ id: 'p' });
eval(extractFn('taskUrl'));
S.viewingAttempt = 'attempt-2';
ok(taskUrl('attempt-2', { num: 14 }) === '/org/project/tasks/attempt-2', 'explicit attempt tabs retain the execution permalink');
S.viewingAttempt = null;
ok(taskUrl('attempt-2', { num: 14 }) === '/org/project/tasks/14', 'logical task links retain their task number');

const currentHtml = taskAttempts({ taskId: 'attempt-1', stage: 'done', status: 'done', state: {} });
const currentCard = currentHtml.match(/<a[^>]*aria-current="true"[^>]*>[\s\S]*?<\/a>/)?.[0] || '';
ok(currentCard.includes('done') && !currentCard.includes('working'),
  'selected attempt status comes from its current view, not the older group snapshot');

ok(stageLabel({ stage: 'setup', state: { draft: true } }) === 'draft', 'draft stage is labelled clearly');
const archivedDraftRow = taskRow({
  id: 'attempt-2', title: 'Task', workflow: 'software-dev', num: 14,
  params: { draft: true, archived: true },
  lastView: { stage: 'setup', status: 'waiting', state: { draft: true } },
});
ok(archivedDraftRow.includes('data-id="attempt-2"') && !archivedDraftRow.includes('data-draft='),
  'an archived draft principal opens the logical task page instead of the standalone draft form');
ok(archivedDraftRow.includes('data-unarchive="attempt-2"') && archivedDraftRow.includes('archived</span>'),
  'an archived draft principal exposes its archived state and Unarchive control');

// Native links own keyboard and modified-click navigation. The creation action
// must stay single-flight across rerenders and never pull users back after leaving.
const button = {
  disabled: false,
  addEventListener(event, handler) { this[event] = handler; },
};
global.document = { getElementById: () => button, querySelectorAll: () => [] };
const navigated = [];
global.spaNavigate = async (href) => { navigated.push(href); S.selected = 'new-draft'; };
global.refreshTasks = async () => {};
global.openTaskForm = async () => {};
global.toast = () => {};
eval(extractFn('wireAttempts'));
(async () => {
  const crown = {
    disabled: false, dataset: { attemptPrincipal: 'attempt-2' },
    getAttribute: () => 'false',
    addEventListener(event, handler) { this[event] = handler; },
  };
  document.querySelectorAll = () => [crown];
  const crownCalls = [];
  global.api = async (url, options) => { crownCalls.push([url, options.method]); };
  let refreshed = 0;
  global.refreshTask = async () => { refreshed++; };
  S.selected = 'attempt-1';
  wireAttempts({ taskId: 'attempt-1' });
  await crown.click();
  ok(crownCalls[0]?.[0] === '/api/tasks/attempt-2/principal' && crownCalls[0]?.[1] === 'POST', 'crown selects its own attempt');
  ok(S.viewingAttempt === 'attempt-1' && refreshed === 1, 'changing principal preserves the viewed attempt and refreshes');
  global.api = async () => { throw new Error('Rejected'); };
  await crown.click();
  ok(!crown.disabled, 'rejected crown selection can be retried');
  document.querySelectorAll = () => [];
  let resolve;
  let calls = 0;
  global.api = () => { calls++; return new Promise((done) => { resolve = done; }); };
  S.selected = 'attempt-2';
  wireAttempts({ taskId: 'attempt-2' });
  const first = button.click({ currentTarget: button });
  await button.click({ currentTarget: button });
  ok(calls === 1 && button.disabled, 'duplicate create clicks make one request');
  ok(taskAttempts({ taskId: 'attempt-2' }).includes('disabled'), 'pending creation remains disabled after rerender');
  S.selected = 'another-task';
  resolve({ id: 'new-draft', projectId: 'p' });
  await first;
  ok(navigated.length === 0, 'creation does not hijack navigation after leaving');
  ok(!S.addingAttempt && !button.disabled, 'creation releases its pending state');
  S.selected = 'attempt-2';
  const next = button.click({ currentTarget: button });
  resolve({ id: 'new-draft', projectId: 'p' });
  await next;
  ok(navigated[0] === '/org/project/tasks/new-draft/parameters', 'new draft navigates to a durable execution permalink');
  global.api = async () => { throw new Error('Failed'); };
  await button.click({ currentTarget: button });
  ok(!S.addingAttempt && !button.disabled, 'failed creation can be retried');
  S.attemptGroup.committedAttemptId = 'attempt-1';
  ok(taskAttempts({ taskId: 'attempt-2' }).includes('Selected to merge'), 'merge winner is clearly identified');
  ok(taskAttempts({ taskId: 'attempt-2' }).includes('disabled'), 'committed group disables creation');
  S.attemptGroup.attempts = [S.attemptGroup.attempts[0]];
  ok(taskAttempts({ taskId: 'attempt-1' }) === '', 'single attempt does not repeat a navigation card');
  ok(addAttemptButton('tabs-action').includes('id="add-attempt"') && addAttemptButton().includes('disabled'), 'single attempt keeps the creation action, still locked after merge');
  // Two opens of the same attempt can resolve out of order (A → B → A).
  // The old request must not overwrite the most recent page projection.
  global.term = null;
  global.DEFAULT_EXPLANATION_SETTINGS = {};
  global.renderTaskLoadingPage = () => {};
  global.renderTaskPage = () => {};
  global.pendingCancellationView = (view) => view;
  global.defaultTaskTab = () => 'overview';
  global.loadParamDefaults = async () => ({});
  let oldView;
  let viewCalls = 0;
  global.api = async (url) => {
    if (url === '/api/tasks/attempt-1') {
      if (++viewCalls === 1) return new Promise((resolve) => { oldView = resolve; });
      return { taskId: 'attempt-1', title: 'Latest' };
    }
    if (url.endsWith('/explanation-settings')) return { effective: {} };
    if (url.endsWith('/attempts')) return S.attemptGroup;
    return [];
  };
  global.scheduleTaskPageRender = () => {};
  eval(extractFn('mergeTaskHistory'));
  eval(extractFn('refreshTaskHistory'));
  eval(extractFn('openTask'));
  const staleOpen = openTask('attempt-1', 'overview', true);
  await openTask('attempt-1', 'overview', true);
  oldView({ taskId: 'attempt-1', title: 'Stale' });
  await staleOpen;
  ok(S.view.title === 'Latest', 'older same-attempt loads cannot replace the latest view');
  ok(S.viewingAttempt === 'attempt-1', 'explicit opening pins the selected attempt');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
