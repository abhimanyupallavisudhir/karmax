// Run: node --test web/notification-delivery.test.cjs
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
function extractFn(name) {
  const start = src.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  if (start < 0) throw new Error(`${name} not found`);
  let parens = 0;
  let open = -1;
  for (let i = src.indexOf('(', start); i < src.length; i++) {
    if (src[i] === '(') parens++;
    else if (src[i] === ')') parens--;
    else if (src[i] === '{' && parens === 0) { open = i; break; }
  }
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function browser() {
  const alerts = [];
  const timers = [];
  const state = { organizationId: 'org', inbox: [], activity: [], tab: 'inbox' };
  let response = [];
  const ctx = vm.createContext({
    S: state, Map, Set, URGENCY_LEVELS: ['low', 'normal', 'high', 'critical'],
    location: { protocol: 'https:', host: 'example.test' },
    WebSocket: function () {},
    api: async () => { if (response instanceof Error) throw response; return response; },
    announceInbox: (items) => alerts.push(...items),
    updateBell() {}, bgRenderMain() {}, patchTaskListFromEvent: () => false,
    LIST_RELOAD_EVENTS: new Set(), setWsOnline() {}, checkConsoleRevision() {},
    refreshTasks: async () => {},
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
  });
  vm.runInContext('let inboxRefreshTimer; let wsHadDropped = false;\n' +
    ['urgencyRank', 'inboxArrivals', 'loadInbox', 'inboxEventChanges', 'scheduleInboxReload', 'connectWs']
      .map(extractFn).join('\n'), ctx);
  return { ctx, state, alerts, timers, respond: (value) => { response = value; } };
}
const ask = (id, urgency = 'high') => ({ id, urgency, unread: true });
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('escalation websocket event fetches and announces without navigation, and coalesces bursts', async () => {
  const b = browser();
  await b.ctx.loadInbox();
  b.ctx.connectWs();
  b.respond([ask('phone-confirmation')]);
  for (let n = 0; n < 10; n++) b.state.ws.onmessage({ data: JSON.stringify({ type: 'task.escalated' }) });
  assert.equal(b.timers.length, 1);
  b.timers.shift()();
  await flush();
  assert.equal(b.alerts.length, 1);
  assert.equal(b.alerts[0].id, 'phone-confirmation');
  await b.ctx.loadInbox();
  assert.equal(b.alerts.length, 1);
  b.respond([ask('phone-confirmation', 'critical')]);
  await b.ctx.loadInbox();
  assert.equal(b.alerts.length, 2);
});

test('reconnection fetches missed asks; first load and organization switches stay quiet', async () => {
  const b = browser();
  b.respond([ask('old')]);
  await b.ctx.loadInbox();
  assert.equal(b.alerts.length, 0);
  b.ctx.connectWs();
  b.state.ws.onclose();
  b.respond([ask('old'), ask('missed')]);
  b.state.ws.onopen();
  await flush();
  assert.equal(b.alerts[0].id, 'missed');
  b.state.organizationId = 'other';
  b.respond([ask('other-org')]);
  await b.ctx.loadInbox();
  assert.equal(b.alerts.length, 1);
});

test('failed fetch preserves arrivals and inbox instead of replaying the backlog', async () => {
  const b = browser();
  b.respond([ask('old')]);
  await b.ctx.loadInbox();
  b.respond(new Error('offline'));
  await assert.rejects(b.ctx.loadInbox(), /offline/);
  assert.equal(b.state.inbox[0].id, 'old');
  b.respond([ask('old'), ask('new')]);
  await b.ctx.loadInbox();
  assert.deepEqual(b.alerts.map((item) => item.id), ['new']);
});

test('review checkpoint refreshes the selected task without clearing streaming output or notifying the inbox', () => {
  const b = browser();
  b.state.selected = 'task';
  b.state.taskEvents = [];
  b.state.liveOutput = 'Still working';
  let refreshes = 0;
  b.ctx.refreshTask = () => { refreshes++; };
  b.ctx.connectWs();
  b.state.ws.onmessage({ data: JSON.stringify({ type: 'review.updated', taskId: 'task', payload: {} }) });
  assert.equal(refreshes, 1);
  assert.equal(b.state.liveOutput, 'Still working');
  assert.equal(b.timers.length, 0);
});

for (const partialFailure of [false, true]) test(`mark all read updates rows and counts, partial failure=${partialFailure}`, async () => {
  const b = browser();
  b.state.inbox = [ask('a'), ask('b'), { ...ask('read'), unread: false }];
  b.ctx.inboxItems = () => b.state.inbox.filter((item) => item.unread);
  let renders = 0;
  b.ctx.renderMain = () => { renders++; };
  b.ctx.renderRail = () => {};
  b.ctx.api = async (url) => {
    if (partialFailure && url.includes('/b?')) throw new Error('offline');
    return { unread: false };
  };
  vm.runInContext(extractFn('markVisibleInboxRead'), b.ctx);
  if (partialFailure) await assert.rejects(b.ctx.markVisibleInboxRead(), /1 notifications/);
  else await b.ctx.markVisibleInboxRead();
  assert.equal(b.state.inbox[0].unread, false);
  assert.equal(b.state.inbox[1].unread, partialFailure);
  assert.equal(renders, 1);
  assert.equal(b.state.inboxLoadEpoch, 1);
});

test('bulk read wins over an in-flight inbox fetch without hiding later arrivals', async () => {
  const b = browser();
  b.state.inbox = [ask('a')];
  b.ctx.inboxItems = () => b.state.inbox;
  b.ctx.renderMain = b.ctx.renderRail = () => {};
  let finishFetch;
  b.ctx.api = async (url, options) => options ? { unread: false }
    : new Promise((resolve) => { finishFetch = resolve; });
  vm.runInContext(extractFn('markVisibleInboxRead'), b.ctx);
  const pending = b.ctx.loadInbox();
  await b.ctx.markVisibleInboxRead();
  finishFetch([ask('a')]);
  await pending;
  assert.equal(b.state.inbox[0].unread, false);
  b.ctx.api = async () => [{ ...ask('a'), unread: false }, ask('new')];
  await b.ctx.loadInbox();
  assert.equal(b.state.inbox[1].unread, true);
});
