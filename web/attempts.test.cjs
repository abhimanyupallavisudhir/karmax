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
  const open = src.indexOf('{', start);
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
      { id: 'attempt-1', attemptNumber: 1, params: {}, lastView: { stage: 'do', status: 'active', state: {} } },
      { id: 'attempt-2', attemptNumber: 2, params: { draft: true } },
    ],
  },
};

eval(extractFn('taskRecord'));
eval(extractFn('stageLabel'));
eval(extractFn('taskAttempts'));

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
ok(taskRecord('attempt-2')?.params?.draft === true, 'task page resolves non-principal records from the attempt group');
ok(stageLabel({ stage: 'setup', state: { draft: true } }) === 'draft', 'draft stage is labelled clearly');

// Clicking either a sibling or the principal performs an explicit attempt switch,
// which prevents principal auto-redirection from snapping the page back.
const buttons = ['attempt-1', 'attempt-2'].map((id) => ({
  dataset: { attemptSelect: id },
  addEventListener(_event, handler) { this.click = handler; },
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
buttons[0].click();
ok(JSON.stringify(opened) === JSON.stringify([['attempt-1', 'overview', true]]), 'principal row switches back explicitly');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
