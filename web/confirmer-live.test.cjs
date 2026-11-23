// A Review step asking a task's agent itself while that task works (ConfirmLayer.live,
// the default Review of a task an agent creates) keeps doing so when the task's
// form or Parameters are saved — and stops once the step forks another agent.
// Run: node web/confirmer-live.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const slice = (name) => {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} is defined`);
  return src.slice(start, src.indexOf('\n}\n', start) + 2);
};
let readSpec;
// What the evaluated function calls, as app.js defines them.
globalThis.readAgentBlock = () => readSpec;
eval(slice('readConfirmerLayers'));

const row = (live) => ({
  dataset: live ? { live } : {},
  querySelector: (selector) => (selector === '.cf-kind' ? { value: 'agent' } : selector === '.cf-max-revisions-input' ? { value: '' } : {}),
});
const box = (live) => ({ querySelectorAll: () => [row(live)] });

readSpec = { provider: 'claude', resumeFrom: { taskId: 'task_c', role: 'do' } };
assert.deepEqual(readConfirmerLayers(box('task_c')), [{ kind: 'agent', provider: 'claude', resumeFrom: { taskId: 'task_c', role: 'do' }, live: true }]);
// Forking another task's agent now: a fork, as chosen.
readSpec = { provider: 'claude', resumeFrom: { taskId: 'task_d', role: 'do' } };
assert.deepEqual(readConfirmerLayers(box('task_c')), [{ kind: 'agent', provider: 'claude', resumeFrom: { taskId: 'task_d', role: 'do' } }]);
assert.deepEqual(readConfirmerLayers(box(undefined)), [{ kind: 'agent', provider: 'claude', resumeFrom: { taskId: 'task_d', role: 'do' } }]);

// The step says so on hover, and an edit to `live` counts as a change.
assert.match(slice('cfLayerHtml'), /data-live="\$\{esc\(layer\.resumeFrom\.taskId\)\}" title="That task's agent reviews this itself while it still works; a fork of it reviews once it has finished\."/);
assert.match(src, /maxRevisions: l\.maxRevisions \?\? null, live: !!\(l\.live && l\.resumeFrom\?\.taskId\) \}/);
console.log('confirmer live step: ok');
