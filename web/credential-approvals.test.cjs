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

for (const name of ['policyTip', 'credentialRequestTaskLink', 'credentialChoices', 'credentialRequestRows', 'requestReasonLine', 'subTaskAskLine', 'permissionAskHtml', 'permissionRequestRows', 'ignoredChip', 'ignoreRequestButton', 'defaultTaskTab']) eval(extractFn(name));

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
ok(link.includes('href="/personal/app/tasks/12/checkin"'), 'request links to the task conversation, where it waits');
ok(link.includes('#12 · Log in'), 'request uses the human task number and title');
ok(!link.includes('task_opaque'), 'opaque task id is hidden when human metadata is available');

const rows = credentialRequestRows([request], [{ id: 'vi_1', label: 'Example login' }]);
ok(rows.includes('Example login') && rows.includes('sign in'), 'request row explains the item and reason');
ok(rows.includes('data-vreq-act="once"') && rows.includes('data-vreq-act="always"'), 'request row exposes the decision scopes');
ok(!rows.includes('tell the agent'), 'request UI never asks the human to perform a mechanical retry');
// #367 review item 16: "Once" on a passkey loads it into the agent's browser
// for a whole sign-in session, not one operation; say so.
const passkeyRows = credentialRequestRows([request], [{ id: 'vi_1', label: 'GitHub passkey', type: 'passkey' }]);
ok(/Allow once: .*passkey.*agent.*browser.*3 minutes/.test(passkeyRows.replace(/&#39;|’/g, "'")), 'a passkey once-grant says it lasts a browser session');
ok(!/Allow once: .*3 minutes/.test(rows), 'other once-grants keep the one-operation wording');
// The answers say what they allow (the request said "Once / This task / Always"; owner, 2026-11-04).
ok(rows.includes('>Allow once<') && rows.includes('>Allow for this task<') && rows.includes('>Always allow<') && rows.includes('>Deny<'), 'each answer is named by what it allows');
ok(rows.includes('Use “Example login” without seeing it?'), 'the request asks a plain question');
const sessionRows = credentialRequestRows([request], [{ id: 'vi_1', label: 'notes.test (signed in)', type: 'session' }]);
ok(/Allow once: Signs the agent's browser in to this site once/.test(sessionRows.replace(/&#39;|’/g, "'")), 'a session once-grant says it signs the browser in once');

// Each request as the gateway lists it: with `ask`, its words (src/domain/permission-ask.ts).
const permission = {
  id: 'preq_1',
  type: 'permission',
  taskId: 'task_opaque',
  capabilities: ['settings:read', 'settings:write'],
  audience: ['@team:operators'],
  reason: 'configure outbound email',
  status: 'pending',
  task: request.task,
  ask: { question: "Give #12's agent settings:read and settings:write?", detail: 'Permissions: settings:read, settings:write' },
};
const permissionRows = permissionRequestRows([permission]);
ok(permissionRows.replace(/&#39;/g, "'").includes("Give #12's agent settings:read and settings:write?"),
  'permission request row asks what it grants, by name');
ok(permissionRows.includes('title="Permissions: settings:read, settings:write"'), 'every permission is in its tooltip');
ok(permissionRows.includes('@team:operators') && permissionRows.includes('configure outbound email'),
  'permission request row explains its audience and reason');
ok(permissionRows.includes('data-preq-act="approve"') && permissionRows.includes('data-preq-act="deny"'),
  'permission request row exposes approve and deny decisions');

// preq_mx07uw7p312057c6ae (#1060): a request adding only a project read "Give the agent 0 permissions?".
const scopeRows = permissionRequestRows([{ ...permission, capabilities: [], projectIds: ['proj_docs'],
  baseAuthorization: { level: 'developer' },
  ask: { question: "Let #1060's agent work in admin<script> too (as Developer)?", detail: 'Projects: admin<script> (as Developer)' } }]);
ok(scopeRows.replace(/&#39;/g, "'").includes("Let #1060's agent work in admin&lt;script&gt; too (as Developer)?") && !scopeRows.includes('<script>'),
  'a project-only request names the project, escaped');
ok(!/\b0 permissions?\b/.test(scopeRows) && !scopeRows.includes('approval-request-caps'), 'it never counts 0 permissions');
ok(permissionAskHtml({ capabilities: ['x'] }, 'q') === '<span class="q">Allow this permission request?</span>', 'a request without words still asks plainly');

ok(defaultTaskTab({ approvalRequests: 1, actions: [] }) === 'checkin', 'a task needing approval opens its conversation, where the request waits');
ok(defaultTaskTab({ approvalRequests: 0, actions: [{ name: 'confirm', enabled: true }] }) === 'checkin', 'review-only tasks retain the Check-in default');
// A sub-task's request names the parent it came through, and the note its agent added.
const via = credentialRequestRows([{ ...request, via: { taskId: 'task_lead', at: 1 } }], [{ id: 'vi_1', label: 'Example login' }]);
ok(via.includes('Via') && via.includes('task_lead'), 'a sub-task request names the parent it came via');
const noted = credentialRequestRows([{ ...request, audience: ['user:ann'], via: { taskId: 'task_lead', note: 'Billing needs <our> login', at: 1 } }],
  [{ id: 'vi_1', label: 'Example login' }]);
ok(noted.includes('Billing needs &lt;our&gt; login'), 'the parent\'s note shows, escaped');
ok(!rows.includes('Via '), 'a top-level task request names no parent');

ok(defaultTaskTab({ approvalRequests: 0, actions: [] }) === 'checkin', 'tasks open on Check-in by default');
ok(defaultTaskTab({ approvalRequests: 0, actions: [], state: { draft: true } }) === 'parameters', 'drafts open on their parameters');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
