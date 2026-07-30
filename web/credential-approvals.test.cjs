// Regression coverage for the task-level credential approval presentation.
// Run: node web/credential-approvals.test.cjs
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

function extractFn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let parens = 0;
  let open = -1;
  for (let i = src.indexOf('(', start); i < src.length; i++) {
    if (src[i] === '(') parens++;
    else if (src[i] === ')') parens--;
    else if (src[i] === '{' && parens === 0) {
      open = i;
      break;
    }
  }
  if (open < 0) throw new Error(`body for ${name} not found`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

global.esc = (value) => String(value ?? '').replace(/[&<>"]/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
})[char]);
global.taskRecord = () => undefined;
global.projectById = (id) => id === 'project_1' ? { id, name: 'App' } : undefined;
global.projectBase = () => '/personal/app';

for (const name of ['credentialRequestTaskLink', 'credentialRequestRows', 'permissionRequestRows', 'defaultTaskTab']) eval(extractFn(name));

let pass = 0;
let fail = 0;
const ok = (condition, message) => condition ? pass++ : (fail++, console.error('FAIL:', message));

const request = {
  id: 'vreq_1',
  taskId: 'task_opaque',
  itemId: 'vi_1',
  mode: 'use',
  why: 'sign in',
  status: 'pending',
  task: { id: 'task_opaque', num: 12, title: 'Log in', projectId: 'project_1' },
};
const link = credentialRequestTaskLink(request);
ok(link.includes('href="/personal/app/tasks/12/approvals"'), 'request links directly to the task Approval Requests tab');
ok(link.includes('#12 · Log in'), 'request uses the human task number and title');
ok(!link.includes('task_opaque'), 'opaque task id is hidden when human metadata is available');

const rows = credentialRequestRows([request], [{ id: 'vi_1', label: 'Example login' }]);
ok(rows.includes('Example login') && rows.includes('sign in'), 'request row explains the item and reason');
ok(rows.includes('data-vreq-act="once"') && rows.includes('data-vreq-act="always"'), 'request row exposes the decision scopes');
ok(!rows.includes('tell the agent'), 'request UI never asks the human to perform a mechanical retry');

const permission = {
  id: 'preq_1',
  type: 'permission',
  taskId: 'task_opaque',
  capabilities: ['settings:read', 'settings:write'],
  audience: ['@team:operators'],
  reason: 'configure outbound email',
  status: 'pending',
  task: request.task,
};
const permissionRows = permissionRequestRows([permission]);
ok(permissionRows.includes('settings:read') && permissionRows.includes('settings:write'),
  'permission request row names every exact capability');
ok(permissionRows.includes('@team:operators') && permissionRows.includes('configure outbound email'),
  'permission request row explains its audience and reason');
ok(permissionRows.includes('data-preq-act="approve"') && permissionRows.includes('data-preq-act="deny"'),
  'permission request row exposes approve and deny decisions');

ok(defaultTaskTab({ approvalRequests: 1, actions: [] }) === 'approvals', 'a task needing approval opens its dedicated tab');
ok(defaultTaskTab({ approvalRequests: 0, actions: [{ name: 'confirm', enabled: true }] }) === 'checkin', 'review-only tasks retain the Check-in default');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
