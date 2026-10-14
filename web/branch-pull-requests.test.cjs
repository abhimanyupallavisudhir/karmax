// Run: node web/branch-pull-requests.test.cjs
// A task with several branches (software-dev ≥1.30): each branch's row links
// to its pull request's sub-task, and no branch shows a Review approval mark —
// pull requests are reviewed on their own tasks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw Error(name);
}
const context = vm.createContext({
  esc: (s) => String(s ?? ''), policyTip: () => '', safeHref: String, stageLabel: (v) => v.stage || 'Do',
  S: { tasks: [{ id: 'task_pr1', num: 41, lastView: { stage: 'review', status: 'waiting' } }] },
});
vm.runInContext(['taskRecord', 'numLabel', 'subTaskState', 'checkoutsSection'].map((name) => {
  if (name === 'taskRecord') return 'function taskRecord(id) { return S.tasks.find((t) => t.id === id); }';
  return extract(name);
}).join('\n'), context);

test('a branch with a pull request links to it; one without has no approval mark', () => {
  const html = context.checkoutsSection({
    stage: 'do', actions: [],
    checkouts: [
      { name: 'app', branch: 'tavya/task_x', base: 'main', target: 'main', approved: false },
      { name: 'docs', branch: 'tavya/task_x-docs', base: 'main', target: 'main', approved: false },
    ],
    shipments: [{ checkout: 'docs', childTaskId: 'task_pr1', branch: 'tavya/task_pr1', fromBranch: 'tavya/task_x-docs', head: 'abc', target: 'main', state: 'open', requestId: 'r' }],
  });
  assert.match(html, /data-open="task_pr1"[^>]*>#41</);
  assert.match(html, /<b>docs<\/b>/);
  assert.doesNotMatch(html, /data-approve-checkout/);
  // The docs row shows its pull request, not an approval mark.
  const docsRow = html.slice(html.indexOf('<b>docs</b>') - 200, html.indexOf('<b>docs</b>'));
  assert.doesNotMatch(docsRow, /checkout-mark/);
  assert.doesNotMatch(html, /Not yet approved/);
});
