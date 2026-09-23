// Run: node web/resource-review.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const wire = src.slice(src.indexOf('function resourceReviewPlaceholder('), src.indexOf('\nfunction setStopBtn('));
const tabs = src.slice(src.indexOf('function taskTabBody('), src.indexOf('\nfunction approvalRequestsTab('));
const freshness = src.slice(src.indexOf('function beginAsyncElementRender('), src.indexOf('\n}', src.indexOf('function beginAsyncElementRender(')) + 2);
const candidate = { resource: { id: 'r1', name: 'Dataset', target: { kind: 'path', path: 'data' } }, candidate: { id: 'c1', state: 'pending', sourceKind: 'path', sourcePath: 'output', worldGeneration: 1 } };
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
      return [{ dataset: { candidateId: 'c1', resourceId: 'r1' }, setAttribute() {}, closest() { return { querySelector() { return { textContent: '' }; } }; }, addEventListener: (_, fn) => { listeners[selector] = fn; } }];
    },
    querySelector() { return null; },
  };
}
function setup(api) {
  let wrap = panel();
  const inventory = panel();
  const context = vm.createContext({ api, resourceReviewCache: new Map(), resourceInventoryCache: new Map(), resourceChoiceWrites: new Map(), asyncElementRenderEpoch: new WeakMap(),
    document: { getElementById: (id) => id === 'review-resource-inventory' ? inventory : wrap }, esc: String, formatBytes: String, confirm: () => true, toast: () => {},
    S: {}, ICON: {}, siteNameMarkup: () => 'Karmax', markdownEnabled: () => false, conversationMathEnabled: () => true, renderAgentMessageBody: String, explainMessageAffordance: () => '',
    waitingText: () => 'Waiting', liveRoleFor: () => 'do', conversationPresence: () => ({ tone: 'waiting', label: 'Waiting' }),
    conversationEntries: () => [], subTasksSection: () => '', agentForksSection: () => '', pipelineLarge: () => '',
    checkoutsSection: () => '', renderWidgetGroups: () => '', notesSection: () => '',
    conversationApprovalRequests: () => '',
    approvalRequestsTab: () => 'approvals', parametersTab: () => 'parameters',
  });
  vm.runInContext(`${freshness}\n${tabs}\n${wire}`, context);
  for (const name of ['humanWaitDetail', 'conversationTextKey', 'conversationInputRequest', 'overviewTab', 'safeHref', 'reviewActionBtn', 'conversationReviewInfo', 'conversationFullscreenButton', 'conversationPane', 'renderConversationEntry']) {
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
  assert.match(h.wrap.innerHTML, /Exclude/);
  assert.match(h.wrap.innerHTML, /Included/);
  assert.equal(h.inventory.innerHTML, '');
  finishInventory({ entries: [{ path: 'ignored.log', bytes: 10 }] });
  await scan;
  assert.match(h.inventory.innerHTML, /ignored.log/);
  assert.match(h.wrap.innerHTML, /Exclude/);
});

test('the second first-open paint subscribes to the same pending read and receives its buttons', async () => {
  let finishResources, calls = 0;
  const h = setup(() => { calls++; return new Promise((r) => { finishResources = r; }); });
  const compactPaint = h.context.wireResourceReview(reviewView);
  h.replace();
  const detailsPaint = h.context.wireResourceReview({ ...reviewView });
  assert.equal(calls, 1);
  finishResources([candidate]);
  await Promise.all([compactPaint, detailsPaint]);
  assert.match(h.wrap.innerHTML, /Exclude/);
});

test('an ignored-file scan failure leaves candidate controls usable', async () => {
  const h = setup(async (url) => { if (url.endsWith('/inventory')) throw Error('sandbox unavailable'); return [candidate]; });
  await Promise.all([h.context.wireResourceInventory(reviewView), h.context.wireResourceReview(reviewView)]);
  assert.match(h.inventory.innerHTML, /Couldn’t inspect ignored output/);
  assert.match(h.wrap.innerHTML, /Exclude/);
});

test('exclusions save without refreshing the list and can be undone', async () => {
  const calls = [];
  const h = setup(async (url, options) => {
    calls.push({ url, options });
    return options?.method === 'PUT' ? { excluded: JSON.parse(options.body).excluded } : [candidate];
  });
  await h.context.wireResourceReview(reviewView);
  await h.wrap.listeners['.resource-exclude']();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, '/api/tasks/task/resources/r1/selection');
  assert.deepEqual(JSON.parse(calls[1].options.body), { excluded: true });
  await h.wrap.listeners['.resource-exclude']();
  assert.equal(calls.length, 3);
  assert.deepEqual(JSON.parse(calls[2].options.body), { excluded: false });
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
  assert.match(h.wrap.innerHTML, /Exclude/);
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
  assert.match(h.wrap.innerHTML, /Exclude/);
});

test('confirmation waits for all saving rows and a failed save prevents confirmation', async () => {
  const h = setup();
  let finishFirst, finishSecond;
  h.context.resourceChoiceWrites.set('task/r1', { promise: new Promise((r) => { finishFirst = r; }) });
  h.context.resourceChoiceWrites.set('task/r2', { promise: new Promise((r) => { finishSecond = r; }) });
  let finished = false;
  const waiting = h.context.waitResourceChoices('task').then(() => { finished = true; });
  h.context.resourceChoiceWrites.delete('task/r1'); finishFirst();
  await Promise.resolve();
  assert.equal(finished, false);
  h.context.resourceChoiceWrites.delete('task/r2'); finishSecond();
  await waiting;
  assert.equal(finished, true);
  h.context.resourceChoiceWrites.set('task/r3', { promise: Promise.reject(new Error('save failed')) });
  await assert.rejects(h.context.waitResourceChoices('task'), /save failed/);
});

test('a replacement panel subscribes to an exclusion already being saved', async () => {
  let finish;
  const h = setup(async (_url, options) => options?.method === 'PUT'
    ? new Promise((r) => { finish = r; }) : [structuredClone(candidate)]);
  await h.context.wireResourceReview(reviewView);
  const saving = h.wrap.listeners['.resource-exclude']();
  h.replace();
  await h.context.wireResourceReview({ ...reviewView });
  finish({ excluded: true });
  await saving;
  assert.equal(h.context.resourceChoiceWrites.size, 0);
  // The new row must now offer Include; clicking sends excluded:false.
  const urls = [];
  h.context.api = async (_url, options) => { urls.push(JSON.parse(options.body)); return {}; };
  await h.wrap.listeners['.resource-exclude']();
  assert.deepEqual(urls, [{ excluded: false }]);
});

test('an interrupted discard is not offered for inclusion or adoption', async () => {
  for (const automaticReview of [true, false]) {
    const h = setup(async () => [{ ...candidate, automaticReview, candidate: { ...candidate.candidate, state: 'discarding' } }]);
    await h.context.wireResourceReview(reviewView);
    assert.match(h.wrap.innerHTML, /Discard pending/);
    assert.doesNotMatch(h.wrap.innerHTML, /resource-exclude|data-action="adopt"/);
    if (!automaticReview) assert.match(h.wrap.innerHTML, /Retry discard/);
  }
});
