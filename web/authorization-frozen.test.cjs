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
});
vm.runInContext(['normalizedAuthorization', 'authorizationSummary', 'authorizationLiveKey', 'authorizationSection'].map(fn).join('\n'), context);

const done = context.authorizationSection({ taskId: 'task', stage: 'done', status: 'done' });
assert.match(done, /Authorization/, 'a finished task still shows its authorization');
assert.match(done, /Developer · Shop · 2 vault credentials/, 'it names the role, scope and credential grants');
assert.match(done, /Frozen — this task has finished/, 'it says why it cannot be edited');
assert.doesNotMatch(done, /tp-auth-save|authz-editor/, 'it offers no editor or save');

const landing = context.authorizationSection({ taskId: 'task', stage: 'merge', status: 'active', pointOfNoReturnPassed: true });
assert.match(landing, /Frozen — this task is landing/);

const live = context.authorizationSection({ taskId: 'task', stage: 'do', status: 'active' });
assert.match(live, /tp-auth-save/, 'a running task keeps the editor');

record.params.draft = true;
assert.equal(context.authorizationSection({ taskId: 'task', stage: 'done', status: 'done' }), '', 'drafts edit in the full form');
console.log('authorization-frozen: ok');
