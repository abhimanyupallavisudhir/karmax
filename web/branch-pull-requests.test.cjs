// Run: node web/branch-pull-requests.test.cjs
// The Branches section of a task with several branches (software-dev ≥1.30):
// each branch's pull request is part of the task. Its row says where that pull
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
  taskRecord: () => undefined, numLabel: (id) => id, taskUrl: (id, rec) => `/acme/web/tasks/${rec?.num ?? id}`,
  S: { prApprovals: {} },
});
vm.runInContext(['branchPullRequestState', 'pullRequestLanes', 'pullRequestRows', 'proposalState', 'checkoutsSection',
  'pullRequestLink', 'pullRequestChip', 'approvePullRequestButton', 'pullRequestAsks', 'conversationPullRequestAsks'].map(extract).join('\n'), context);
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
  assert.match(row(html, 'docs'), /<a [^>]*data-open="pr-docs" data-spa href="\/acme\/web\/tasks\/41"[^>]*>Open</, 'Open is a link to its pull-request task');
  assert.match(row(html, 'api'), /Changes requested/);
  assert.match(row(html, 'web'), /Landing/);
  assert.match(row(html, 'cli'), /Landed/);
  assert.match(row(html, 'cli'), /class="checkout-mark">✓/);
  assert.match(row(html, 'old'), /Closed/);
  for (const name of ['api', 'web', 'cli', 'old']) assert.doesNotMatch(row(html, name), /data-approve/);
});

// The task's own proposal is approved by Confirm PR, all of it at once: its
// rows say where each pull request is, without an Approve of their own.
test('at the task\'s own Review, its branches are in review, approved by Confirm PR alone', () => {
  const checkouts = [
    { name: 'app', branch: 'tavya/t', base: 'main', head: 'a1', approved: false,
      pr: { repo: 'app', number: 7, url: 'https://github.com/o/app/pull/7', state: 'open' } },
    { name: 'docs', branch: 'tavya/t-docs', base: 'main', head: 'd1', approved: false,
      pr: { repo: 'docs', number: 8, url: 'https://github.com/o/docs/pull/8', state: 'open' } },
  ];
  const doing = context.checkoutsSection({ stage: 'do', actions: [], checkouts });
  assert.doesNotMatch(doing, /data-approve|In review/);
  const review = context.checkoutsSection({ stage: 'review', status: 'waiting', actions: [{ name: 'confirm' }], checkouts });
  assert.doesNotMatch(review, /data-approve|still to review|○/, 'Confirm PR is the one approval');
  assert.match(row(review, 'docs'), /In review/);
  assert.match(row(review, 'docs'), /#8/);
  const landing = context.checkoutsSection({ stage: 'merge', status: 'active', actions: [],
    checkouts: [{ ...checkouts[0], pr: { ...checkouts[0].pr, merged: true } }, checkouts[1]] });
  assert.match(row(landing, 'app'), /Landed/);
  assert.match(row(landing, 'app'), /class="checkout-mark">✓/);
  assert.match(row(landing, 'docs'), /Landing/);
});

// pramana#102: "pramana" landed one pull request mid-work, then went out again
// with the wiki in the task's own proposal. Its row is that proposal's pull
// request, not the one that landed before.
test('a branch proposed again by the task shows its newest pull request', () => {
  const html = context.checkoutsSection({
    stage: 'review', status: 'waiting', targetBranch: 'master', actions: [{ name: 'confirm' }],
    checkouts: [
      { name: 'pramana', branch: 'tavya/t', base: 'master', target: 'master',
        pr: { repo: 'pramana', number: 91, url: 'https://github.com/o/pramana/pull/91', state: 'open' } },
      { name: 'pramana-wiki', branch: 'tavya/t', base: 'main', target: 'main',
        pr: { repo: 'pramana-wiki', number: 86, url: 'https://github.com/o/pramana-wiki/pull/86', state: 'open' } },
    ],
    shipments: [{ ...lane('pramana', 'pr-76', 'landed'), target: 'master' }],
    subTaskSummaries: [{ id: 'pr-76', title: 'x', workflow: 'software-dev', pullRequest: { checkout: 'pramana', target: 'master' },
      lastView: { stage: 'done', status: 'done' } }],
  });
  assert.match(row(html, 'pramana'), /#91/);
  assert.match(row(html, 'pramana'), /In review/);
  assert.doesNotMatch(row(html, 'pramana'), /Landed|data-open="pr-76"/);
  assert.match(row(html, 'pramana-wiki'), /#86/);
  assert.match(row(html, 'pramana-wiki'), /In review/);
  assert.doesNotMatch(html, /data-approve/);
});

// pramana#102: a run replaced before the fix forgot its pull requests; each
// record still says whose pull request it is, so the row still shows it.
test('a pull request its run forgot is shown from its own record', () => {
  const html = context.checkoutsSection({
    stage: 'do', status: 'waiting', targetBranch: 'main', actions: [],
    checkouts: ['pramana', 'wiki'].map((name) => ({ name, branch: `tavya/t-${name}`, base: 'main', target: 'main' })),
    subTaskSummaries: [
      { id: 'sub', num: 103, title: 'F1', workflow: 'software-dev', lastView: { stage: 'done', status: 'done' } },
      { id: 'pr-old', title: 'first', workflow: 'software-dev', pullRequest: { checkout: 'pramana', target: 'master' }, lastView: { stage: 'done', status: 'done' } },
      { id: 'pr-new', title: 'Breadcrumbs', workflow: 'software-dev', pullRequest: { checkout: 'pramana', target: 'master' },
        lastView: { stage: 'review', status: 'waiting', waitingFor: { kind: 'human' } } },
    ],
  });
  assert.match(row(html, 'pramana'), /In review/);
  assert.match(row(html, 'pramana'), /data-approve-pr="pr-new"/, 'its newest pull request');
  assert.match(row(html, 'pramana'), /→ master/);
  assert.doesNotMatch(row(html, 'wiki'), /chip|Approve/);
  assert.doesNotMatch(html, /data-open="sub"/, 'a sub-task is not a branch');
});

test('a task with one branch still shows that branch\'s pull request', () => {
  const checkouts = [{ name: 'app', branch: 'tavya/t', base: 'main', target: 'main' }];
  assert.equal(context.checkoutsSection({ stage: 'do', actions: [], checkouts }), '', 'nothing to say without one');
  const html = context.checkoutsSection({ stage: 'do', status: 'active', targetBranch: 'main', actions: [], checkouts,
    shipments: [lane('app', 'pr-app')],
    subTaskSummaries: [{ id: 'pr-app', title: 'app: x', workflow: 'software-dev', pullRequest: { checkout: 'app' },
      lastView: { stage: 'review', status: 'waiting', waitingFor: { kind: 'human' } } }] });
  assert.match(row(html, 'app'), /In review/);
  assert.match(row(html, 'app'), /data-approve-pr="pr-app"/);
});

// Approving a pull request shows at once, and every step after it looks alive
// until it lands: Approved, then Landing (with what it waits for), then Landed.
const reviewing = { stage: 'review', status: 'waiting', waitingFor: { kind: 'human' } };
const pending = (lastView, pr) => ({
  stage: 'do', status: 'active', targetBranch: 'main', actions: [],
  checkouts: ['app', 'docs'].map((name) => ({ name, branch: `tavya/t-${name}`, base: 'main', target: 'main' })),
  shipments: [lane('docs', 'pr-docs')],
  subTaskSummaries: [{ id: 'pr-docs', title: 'docs: x', workflow: 'software-dev', lastView,
    pullRequest: { checkout: 'docs', target: 'main', ...(pr ? { pr } : {}) } }],
});

test('Approve shows at once, and its pull request stays visibly alive until it lands', () => {
  context.S.prApprovals = {};
  const github = { number: 86, url: 'https://github.com/o/docs/pull/86', state: 'open' };
  assert.match(row(context.checkoutsSection(pending(reviewing, github)), 'docs'), /href="https:\/\/github.com\/o\/docs\/pull\/86"[^>]*>⇱ #86</);
  context.S.prApprovals = { 'pr-docs': Date.now() };
  const clicked = row(context.checkoutsSection(pending(reviewing)), 'docs');
  assert.match(clicked, /Approved/);
  assert.match(clicked, /chip [^"]*live/, 'a step in progress pulses');
  assert.doesNotMatch(clicked, /data-approve-pr/);
  // Approved and on its way, the record has no person to wait for: not "Opening".
  const approved = row(context.checkoutsSection(pending({ stage: 'review', status: 'active' })), 'docs');
  assert.match(approved, /Approved/);
  context.S.prApprovals = {};
  const landing = row(context.checkoutsSection(pending({ stage: 'merge', status: 'waiting',
    waitingFor: { kind: 'merge', detail: 'Waiting for CI' } })), 'docs');
  assert.match(landing, /Landing/);
  assert.match(landing, /chip [^"]*live/);
  assert.match(landing, /title="Waiting for CI"/);
  assert.doesNotMatch(row(context.checkoutsSection(pending({ stage: 'done', status: 'done' })), 'docs'), /live/);
});

test('a pull request waiting for its approval is a small box in the conversation', () => {
  context.S.prApprovals = {};
  assert.equal(context.conversationPullRequestAsks(pending({ stage: 'do', status: 'active' })), '', 'nothing to approve, nothing shown');
  const box = context.conversationPullRequestAsks(pending(reviewing, { number: 86, url: 'u86', state: 'open' }));
  assert.match(box, /class="pr-ask"/);
  assert.match(box, /<b>docs<\/b>/);
  assert.match(box, /#86/);
  assert.match(box, /data-approve-pr="pr-docs"/);
  // Approved, it stays to show it landing, then goes.
  context.S.prApprovals = { 'pr-docs': Date.now() };
  assert.match(context.conversationPullRequestAsks(pending(reviewing)), /Approved/);
  context.S.prApprovals = {};
  assert.match(context.conversationPullRequestAsks(pending({ stage: 'merge', status: 'active' })), /Landing/);
  assert.equal(context.conversationPullRequestAsks(pending({ stage: 'done', status: 'done' })), '');
});

test('Branches comes first in the details rail', () => {
  const rail = extract('taskRail');
  assert.ok(rail.indexOf('checkoutsSection(v)') < rail.indexOf("section('Attempts'"), 'above Attempts');
  assert.ok(rail.indexOf('checkoutsSection(v)') < rail.indexOf('subTasksSection(v)'), 'above Sub-tasks');
});
