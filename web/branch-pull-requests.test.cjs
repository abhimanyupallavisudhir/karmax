// Run: node web/branch-pull-requests.test.cjs
// The Branches section of a task with several branches (software-dev ≥1.30):
// each branch's pull request is its own sub-task. Its row says where that pull
// request is, links to it, and offers Approve while it waits for a reviewer —
// whatever the task itself is doing. A branch not proposed yet stays quiet.
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
  esc: (s) => String(s ?? ''), policyTip: (text) => `<tip>${text}</tip>`, safeHref: String,
  taskRecord: () => undefined, numLabel: (id) => id,
});
vm.runInContext(['branchPullRequestState', 'checkoutsSection'].map(extract).join('\n'), context);
const row = (html, name) => html.split('<div class="checkout-row').find((part) => part.includes(`<b>${name}</b>`)) ?? '';
const lane = (checkout, childTaskId, state = 'open') =>
  ({ checkout, childTaskId, branch: `tavya/${childTaskId}`, fromBranch: `tavya/t-${checkout}`, head: 'h', target: 'main', state, requestId: 'r' });

test('each branch shows where its pull request is, with Approve while it waits for a reviewer', () => {
  const html = context.checkoutsSection({
    stage: 'do', status: 'active', targetBranch: 'main', actions: [],
    checkouts: ['app', 'docs', 'api', 'cli', 'web', 'old'].map((name) => ({ name, branch: `tavya/t-${name}`, base: 'main', target: 'main' })),
    shipments: [lane('docs', 'pr-docs'), lane('api', 'pr-api'), lane('cli', 'pr-cli', 'landed'), lane('web', 'pr-web'), lane('old', 'pr-old', 'cancelled')],
    subTaskSummaries: [
      { id: 'pr-docs', num: 41, title: 'docs: x', workflow: 'software-dev', lastView: { stage: 'review', status: 'waiting', waitingFor: { kind: 'human' } } },
      { id: 'pr-api', num: 42, title: 'api: x', workflow: 'software-dev', lastView: { stage: 'do', status: 'waiting', waitingFor: { kind: 'parent' } } },
      { id: 'pr-web', num: 44, title: 'web: x', workflow: 'software-dev', lastView: { stage: 'merge', status: 'active' } },
    ],
  });
  assert.doesNotMatch(row(html, 'app'), /chip|Approve|Not yet approved/, 'a branch not proposed yet stays quiet');
  assert.match(row(html, 'docs'), /In review/);
  assert.match(row(html, 'docs'), /data-approve-pr="pr-docs"/);
  assert.match(row(html, 'docs'), /data-open="pr-docs"[^>]*>#41</);
  assert.match(row(html, 'api'), /Changes requested/);
  assert.match(row(html, 'web'), /Landing/);
  assert.match(row(html, 'cli'), /Landed/);
  assert.match(row(html, 'cli'), /class="checkout-mark">✓/);
  assert.match(row(html, 'old'), /Closed/);
  for (const name of ['api', 'web', 'cli', 'old']) assert.doesNotMatch(row(html, name), /data-approve/);
});

test('before 1.30, Approve shows only at the task-wide Review', () => {
  const checkouts = [
    { name: 'app', branch: 'tavya/t', base: 'main', head: 'a1', approved: false },
    { name: 'docs', branch: 'tavya/t-docs', base: 'main', head: 'd1', approved: false },
  ];
  assert.doesNotMatch(context.checkoutsSection({ stage: 'do', actions: [], checkouts }), /data-approve/);
  const review = context.checkoutsSection({ stage: 'review', actions: [{ name: 'confirm' }], checkouts });
  assert.match(review, /data-approve-checkout="docs"/);
  assert.match(review, /2 of 2 still to review/);
});
