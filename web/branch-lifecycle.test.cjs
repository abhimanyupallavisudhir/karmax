// Run: node web/branch-lifecycle.test.cjs
// The Branches section of a multi-PR task (SPEC §11.1). From software-dev 1.30
// every branch has its own lifecycle, so Approve shows on whichever branch is in
// review — while the agent works on, not only at a task-wide Review.
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
const states = src.slice(src.indexOf('const BRANCH_STATE = {'), src.indexOf('};', src.indexOf('const BRANCH_STATE = {')) + 2);
const context = vm.createContext({ esc: (value) => String(value), safeHref: (value) => value, policyTip: (text) => `<tip>${text}</tip>` });
vm.runInContext(`${states}\n${extract('checkoutsSection')}`, context);
const row = (html, name) => html.split('<div class="checkout-row').find((part) => part.includes(`<b>${name}</b>`)) ?? '';

test('each branch shows its own state, and Approve shows on a branch in review while the agent works', () => {
  const html = context.checkoutsSection({
    stage: 'do', status: 'active', targetBranch: 'main', actions: [],
    checkouts: [
      { name: 'app', branch: 'tavya/t', base: 'main', state: 'working', head: 'a1' },
      { name: 'docs', branch: 'tavya/t-docs', base: 'main', state: 'review', proposedHead: 'd1', pr: { number: 7, url: 'u', state: 'open' } },
      { name: 'api', branch: 'tavya/t-api', base: 'main', state: 'approved', approved: true, proposedHead: 'p1' },
      { name: 'cli', branch: 'tavya/t-cli', base: 'main', state: 'landed', landedSha: 'c1' },
    ],
  });
  assert.doesNotMatch(row(html, 'app'), /chip|Approve/, 'a branch not proposed yet stays quiet');
  assert.match(row(html, 'docs'), /In review/);
  assert.match(row(html, 'docs'), /data-approve-checkout="docs"/);
  assert.match(row(html, 'api'), /Approved/);
  assert.doesNotMatch(row(html, 'api'), /data-approve-checkout/);
  assert.match(row(html, 'cli'), /Landed/);
  assert.match(row(html, 'cli'), /class="checkout-mark"[^>]*>✓/);
  assert.match(html, /1 in review <tip>/);
});

test('before 1.30, Approve shows only at the task-wide Review', () => {
  const checkouts = [
    { name: 'app', branch: 'tavya/t', base: 'main', head: 'a1', approved: false },
    { name: 'docs', branch: 'tavya/t-docs', base: 'main', head: 'd1', approved: false },
  ];
  assert.doesNotMatch(context.checkoutsSection({ stage: 'do', actions: [], checkouts }), /data-approve-checkout/);
  const review = context.checkoutsSection({ stage: 'review', actions: [{ name: 'confirm' }], checkouts });
  assert.match(review, /data-approve-checkout="docs"/);
  assert.match(review, /2 of 2 still to review/);
});
