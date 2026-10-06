// A finished (or landing) task keeps its Authorization as a read-only record
// instead of dropping the section. Run: node web/authorization-frozen.test.cjs
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const fn = (name) => {
  const match = source.match(new RegExp(`function ${name}\\([^]*?\\n}`));
  assert.ok(match, name);
  return match[0];
};

const record = { id: 'task', projectId: 'p1', params: { _authorization: { level: 'developer', scope: 'projects', projectIds: ['p1'],
  capabilities: ['project:read', 'use-credential:item:vi_a', 'use-credential:item:vi_b'] } } };
const context = vm.createContext({
  S: { projects: [{ id: 'p1', name: 'Shop', organizationId: 'org' }] },
  TERMINAL_STAGES: ['done', 'cancelled', 'failed'],
  taskRecord: (id) => (id === record.id ? record : undefined),
  esc: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  authorizationLevels: () => [{ id: 'developer', name: 'Developer', scope: 'selectable' }],
  authorizationEditorHtml: () => '<div class="authz-editor"></div>',
  taskPaymentsHtml: (id) => `<div class="task-payments" id="${id}"></div>`,
  paymentsLiveKey: () => 'payments',
  fromMinorUnits: (minor) => String(minor),
});
vm.runInContext(['normalizedAuthorization', 'authorizationSummary', 'authorizationLiveKey', 'agentAuthoritySummary', 'mainAuthorityParams'].map(fn).join('\n'), context);

// The main agent's Authorization row on the Parameters tab.
const done = context.mainAuthorityParams({ taskId: 'task', stage: 'done', status: 'done' });
assert.equal(done.summary, 'Developer · Shop · 2 credentials', 'it names the role, scope and credential grants');
assert.match(done.html, /Developer · Shop · 2 credentials/, 'a finished task still shows its authorization');
assert.match(done.html, /Frozen — this task has finished/, 'it says why it cannot be edited');
assert.doesNotMatch(done.html, /tp-auth-save|authz-editor/, 'it offers no editor or save');
assert.match(done.html, /tp-payments/, 'spending stays visible');

const landing = context.mainAuthorityParams({ taskId: 'task', stage: 'merge', status: 'active', pointOfNoReturnPassed: true });
assert.match(landing.html, /Frozen — this task is landing/);

const live = context.mainAuthorityParams({ taskId: 'task', stage: 'do', status: 'active' });
assert.match(live.html, /tp-auth-save/, 'a running task keeps the editor');
assert.match(live.html, /tp-payments/, 'its cards and budget save with it');
console.log('authorization-frozen: ok');
