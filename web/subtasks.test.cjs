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
global.stageLabel = (v) => v.stage || 'setup';
global.pipeline = (v) => `<i class="test-pipeline">${esc(v.stage || 'setup')}</i>`;

for (const name of ['taskRecord', 'numLabel', 'parentTaskContext', 'subTaskState', 'subTasksSection']) eval(extractFn(name));

let pass = 0, fail = 0;
const ok = (condition, message) => {
  if (condition) pass++;
  else { fail++; console.error('FAIL:', message); }
};

const parentLink = parentTaskContext({ taskId: 'child-a', parentTaskId: 'parent' });
ok(parentLink.includes('Sub-task of') && parentLink.includes('#10 Ship the new workspace'), 'child names its parent in the masthead');
ok(parentLink.includes('data-open="parent"') && parentLink.startsWith('<button'), 'parent context is one keyboard-operable navigation target');
ok(parentTaskContext({ taskId: 'parent' }) === '', 'top-level tasks do not render empty parent chrome');

ok(subTaskState(S.tasks[1]).label === 'In progress', 'active work gets plain-language state');
ok(subTaskState(S.tasks[2]).complete === true, 'done work contributes to completion');
ok(subTaskState(S.tasks[3]).label === 'Needs direction', 'blocked work is called out clearly');

const panel = subTasksSection({
  taskId: 'parent',
  workflow: 'software-dev',
  subTasks: ['child-a', 'child-b', 'child-c'],
});
ok(panel.includes('Polish navigation') && panel.includes('Verify keyboard access') && panel.includes('Resolve visual regression'), 'rows use human titles instead of only ids');
ok(panel.includes('<strong>1</strong> of 3 complete') && panel.includes('--subtask-progress:33%'), 'panel summarizes group progress');
ok((panel.match(/class="subtask-row"/g) || []).length === 3, 'every child is one large navigation row');
ok(panel.includes('Ready to return') === false && panel.includes('Needs direction'), 'meaningful child state appears beside exact pipeline state');
ok(panel.includes('role="progressbar"') && panel.includes('aria-valuenow="1"'), 'completion is exposed to assistive technology');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
