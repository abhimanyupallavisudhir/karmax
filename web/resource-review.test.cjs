// Run: node web/resource-review.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const wire = src.slice(src.indexOf('function resourceReviewPlaceholder('), src.indexOf('\nfunction setStopBtn('));
const tabs = src.slice(src.indexOf('function taskTabBody('), src.indexOf('\nfunction approvalRequestsTab('));
const freshness = src.slice(src.indexOf('function beginAsyncElementRender('), src.indexOf('\n}', src.indexOf('function beginAsyncElementRender(')) + 2);
const candidate = { resource: { name: 'Dataset', target: { kind: 'path', path: 'data' } }, candidate: { id: 'c1', state: 'pending', sourceKind: 'path', sourcePath: 'output', worldGeneration: 1 } };
function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw Error(name);
}
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
  const inventory = panel();
  const context = vm.createContext({ api, resourceReviewCache: new Map(), resourceInventoryCache: new Map(), asyncElementRenderEpoch: new WeakMap(),
    document: { getElementById: (id) => id === 'review-resource-inventory' ? inventory : wrap }, esc: String, formatBytes: String, confirm: () => true, toast: () => {},
    S: {}, siteNameMarkup: () => 'Karmax', markdownEnabled: () => false, conversationMathEnabled: () => true, renderAgentMessageBody: String, explainMessageAffordance: () => '',
    waitingText: () => 'Waiting', liveRoleFor: () => 'do', conversationPresence: () => ({ tone: 'waiting', label: 'Waiting' }),
    conversationEntries: () => [], subTasksSection: () => '', agentForksSection: () => '', pipelineLarge: () => '',
    checkoutsSection: () => '', renderWidgetGroups: () => '', notesSection: () => '',
    approvalRequestsTab: () => 'approvals', parametersTab: () => 'parameters',
  });
  vm.runInContext(`${freshness}\n${tabs}\n${wire}`, context);
  for (const name of ['humanWaitDetail', 'conversationTextKey', 'conversationInputRequest', 'overviewTab', 'safeHref', 'reviewActionBtn', 'conversationReviewInfo', 'conversationPane', 'renderConversationEntry']) {
    vm.runInContext(extract(name), context);
  }
  context.checkinTab = (v) => context.conversationPane(v, { role: 'do' });
  return { context, inventory, get wrap() { return wrap; }, replace() { wrap.isConnected = false; wrap = panel(); } };
}

const reviewView = { taskId: 'task', stage: 'review', status: 'waiting', updatedAt: 1,
  waitingFor: { kind: 'human', detail: '1 staged project resource candidate must be Adopted or Discarded before this proposal can continue.' },
  actions: [{ name: 'followUp', enabled: true }] };

test('resource controls are on Overview and inside the current Input requested message only', () => {
  const { context } = setup();
  assert.match(context.taskTabBody(reviewView, 'overview'), /id="review-resources"/);
  const conversation = context.taskTabBody(reviewView, 'checkin');
  assert.match(conversation, /class="msg agent input-request"[\s\S]*id="review-resources"/);
  assert.doesNotMatch(conversation, /id="review-resource-inventory"/);
  for (const tab of ['approvals', 'parameters']) assert.doesNotMatch(context.taskTabBody(reviewView, tab), /review-resources/);
  assert.doesNotMatch(context.taskTabBody({ ...reviewView, stage: 'do' }, 'checkin'), /review-resources/);
  assert.doesNotMatch(context.taskTabBody({ ...reviewView, waitingFor: null }, 'checkin'), /review-resources/);
  const old = { type: 'input-request', request: { text: 'An older request' } };
  context.conversationEntries = () => [old];
  const history = context.taskTabBody(reviewView, 'checkin');
  assert.equal((history.match(/id="review-resources"/g) || []).length, 1);
  assert.equal(old.resourceReview, undefined, 'history entries are not mutated');
  assert.match(src, /wireResourceReview\(v\);[^\n]*\n  if \(tab === 'overview'\)/);
});

test('first-open Overview shows candidate buttons while the ignored-file scan is still pending', async () => {
  let finishInventory;
  const h = setup(async (url) => url.endsWith('/inventory')
    ? new Promise((r) => { finishInventory = r; }) : [candidate]);
  const scan = h.context.wireResourceInventory(reviewView);
  await h.context.wireResourceReview(reviewView);
  assert.match(h.wrap.innerHTML, /Adopt as project resource/);
  assert.match(h.wrap.innerHTML, /Discard candidate/);
  assert.equal(h.inventory.innerHTML, '');
  finishInventory({ entries: [{ path: 'ignored.log', bytes: 10 }] });
  await scan;
  assert.match(h.inventory.innerHTML, /ignored.log/);
  assert.match(h.wrap.innerHTML, /Adopt as project resource/);
});

test('the second first-open paint subscribes to the same pending read and receives its buttons', async () => {
  let finishResources, calls = 0;
  const h = setup(() => { calls++; return new Promise((r) => { finishResources = r; }); });
  const compactPaint = h.context.wireResourceReview(reviewView);
  h.replace();
  const detailsPaint = h.context.wireResourceReview(reviewView);
  assert.equal(calls, 1);
  finishResources([candidate]);
  await Promise.all([compactPaint, detailsPaint]);
  assert.match(h.wrap.innerHTML, /Adopt as project resource/);
});

test('an ignored-file scan failure leaves candidate controls usable', async () => {
  const h = setup(async (url) => { if (url.endsWith('/inventory')) throw Error('sandbox unavailable'); return [candidate]; });
  await Promise.all([h.context.wireResourceInventory(reviewView), h.context.wireResourceReview(reviewView)]);
  assert.match(h.inventory.innerHTML, /Couldn’t inspect ignored output/);
  assert.match(h.wrap.innerHTML, /Adopt as project resource/);
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
