// Regression coverage for the task-page attempt switcher. Attempts are selectable
// rows (including the principal and drafts), with one unambiguous current marker.
// Run: node web/attempts.test.cjs
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
function extractFn(name) {
  const start = src.indexOf(`function ${name}(`);
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
global.S = {
  tasks: [{ id: 'attempt-1', title: 'Task', projectId: 'p' }],
  taskTab: 'overview',
  attemptGroup: {
    principalAttemptId: 'attempt-1',
    attempts: [
      { id: 'attempt-1', attemptNumber: 1, params: {}, lastView: { stage: 'do', status: 'active', state: {}, stageTransitions: [{ target: 'human', label: 'Waiting for human input' }, { target: 'done', label: 'Done' }] } },
      { id: 'attempt-2', attemptNumber: 2, params: { draft: true }, lastView: { stage: 'setup', status: 'waiting', state: { draft: true }, stageTransitions: [{ target: 'do', label: 'Queue' }, { target: 'done', label: 'Done' }] } },
    ],
  },
};

eval(extractFn('taskRecord'));
eval(extractFn('stageLabel'));
eval(extractFn('stageIndicator'));
eval(extractFn('taskAttempts'));
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
ok(html.includes('data-attempt-select="attempt-1"'), 'principal can be selected again');
ok(html.includes('data-attempt-select="attempt-2"'), 'draft can be selected');
ok(html.includes('attempt-card selected') && html.includes('aria-current="true"'), 'current attempt is visibly and semantically selected');
ok(!html.includes('<details') && !html.includes('View full attempt'), 'switching needs no expansion or secondary action');
ok((html.match(/data-stage-move=/g) || []).length === 2, 'every attempt owns its own stage dropdown');
ok(html.includes('Waiting for human input') && html.includes('Queue'), 'attempt menus render their distinct server-advertised moves');
ok(taskRecord('attempt-2')?.params?.draft === true, 'task page resolves non-principal records from the attempt group');
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

// Clicking either a sibling or the principal performs an explicit attempt switch,
// which prevents principal auto-redirection from snapping the page back.
const buttons = ['attempt-1', 'attempt-2'].map((id) => ({
  dataset: { attemptSelect: id },
  addEventListener(event, handler) { this[event] = handler; },
}));
global.document = {
  getElementById: () => null,
  querySelectorAll: () => buttons,
};
const opened = [];
global.openTask = (...args) => opened.push(args);
global.api = async () => ({});
global.refreshTasks = async () => {};
global.openTaskForm = () => {};
global.toast = () => {};
eval(extractFn('wireAttempts'));
wireAttempts({ taskId: 'attempt-2' });
buttons[0].click({ target: { closest: () => null } });
ok(JSON.stringify(opened) === JSON.stringify([['attempt-1', 'overview', true]]), 'principal row switches back explicitly');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
