// Run: node web/resource-review.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const wire = src.slice(src.indexOf('async function wireResourceReview('), src.indexOf('\nfunction setStopBtn('));
const tabs = src.slice(src.indexOf('function taskTabBody('), src.indexOf('\nfunction approvalRequestsTab('));
const freshness = src.slice(src.indexOf('function beginAsyncElementRender('), src.indexOf('\n}', src.indexOf('function beginAsyncElementRender(')) + 2);
const candidate = { resource: { name: 'Dataset', target: { kind: 'path', path: 'data' } }, candidate: { id: 'c1', state: 'pending', sourceKind: 'path', sourcePath: 'output', worldGeneration: 1 } };
function panel() {
  const classes = new Set(['hidden']);
  const listeners = {};
  return { isConnected: true, innerHTML: '', listeners,
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
    querySelectorAll(selector) {
      if (!this.innerHTML.includes(selector.slice(1))) return [];
      return [{ dataset: { candidateId: 'c1' }, addEventListener: (_, fn) => { listeners[selector] = fn; } }];
    },
    querySelector() { return null; },
  };
}
function setup(api) {
  let wrap = panel();
  const context = vm.createContext({ api, resourceReviewCache: new Map(), asyncElementRenderEpoch: new WeakMap(),
    document: { getElementById: () => wrap }, esc: String, formatBytes: String, confirm: () => true, toast: () => {},
    checkinTab: () => 'conversation', overviewTab: () => 'overview', approvalRequestsTab: () => 'approvals', parametersTab: () => 'parameters',
  });
  vm.runInContext(`${freshness}\n${tabs}\n${wire}`, context);
  return { context, get wrap() { return wrap; }, replace() { wrap.isConnected = false; wrap = panel(); } };
}

test('Review resource panel is present on every tab, including a retained Check-in tab', () => {
  const { context } = setup();
  for (const tab of ['overview', 'checkin', 'approvals', 'parameters']) {
    assert.match(context.taskTabBody({ stage: 'review' }, tab), /id="review-resources"/);
    assert.doesNotMatch(context.taskTabBody({ stage: 'do' }, tab), /id="review-resources"/);
  }
  // Hydration must run outside the Overview-only wiring block.
  assert.match(src, /wireResourceReview\(v\);[^\n]*\n  if \(tab === 'overview'\)/);
  assert.equal((src.match(/id="review-resources"/g) || []).length, 1);
});

test('a task update reveals newly staged candidates despite a recent empty cache; adopt and discard work', async () => {
  for (const action of ['adopt', 'discard']) {
    let items = [];
    const calls = [];
    const h = setup(async (url, options) => {
      calls.push(url);
      if (options?.method === 'POST') { items = []; return {}; }
      return url.endsWith('/inventory') ? { entries: [] } : items;
    });
    const first = { taskId: 'task', stage: 'review' };
    await h.context.wireResourceReview(first);
    assert.equal(h.wrap.classList.contains('hidden'), true);
    items = [candidate];
    h.replace();
    await h.context.wireResourceReview({ ...first });
    assert.equal(h.wrap.classList.contains('hidden'), false);
    assert.match(h.wrap.innerHTML, /Adopt as project resource/);
    assert.match(h.wrap.innerHTML, /Discard candidate/);
    await h.wrap.listeners[`.candidate-${action}`]();
    assert.ok(calls.includes(`/api/tasks/task/resource-candidates/c1/${action}`));
    assert.equal(h.wrap.classList.contains('hidden'), true);
    assert.equal(h.wrap.innerHTML, '');
  }
});

test('detached requests cannot overwrite the current resource cache', async () => {
  let resolve;
  let count = 0;
  const h = setup(async (url) => url.endsWith('/inventory') ? { entries: [] }
    : ++count === 1 ? new Promise((r) => { resolve = r; }) : [candidate]);
  const old = h.context.wireResourceReview({ taskId: 'task', stage: 'review' });
  h.replace();
  const view = { taskId: 'task', stage: 'review' };
  await h.context.wireResourceReview(view);
  resolve([]);
  await old;
  assert.equal(h.context.resourceReviewCache.get('task').view, view);
  assert.match(h.wrap.innerHTML, /Adopt as project resource/);
});

test('a late response cannot replace a newer forced refresh of the same panel', async () => {
  let resolve;
  let count = 0;
  const h = setup(async (url) => url.endsWith('/inventory') ? { entries: [] }
    : ++count === 1 ? new Promise((r) => { resolve = r; }) : [candidate]);
  const view = { taskId: 'task', stage: 'review' };
  const old = h.context.wireResourceReview(view);
  await h.context.wireResourceReview(view, true);
  resolve([]);
  await old;
  assert.match(h.wrap.innerHTML, /Adopt as project resource/);
});
