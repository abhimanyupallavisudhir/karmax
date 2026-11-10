const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const fn = (name) => { const start = src.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm')); return src.slice(start, src.indexOf('\n}', start) + 2); };
test('RQ-11: hidden tabs defer websocket work until visibility returns', () => {
  let inboxReloads = 0;
  const ctx = vm.createContext({ noteRowAskEvent: () => {}, rowAskEpoch: 0, S: { meta: {}, inbox: [] }, document: { hidden: true }, location: { protocol: 'http:', host: 'test' }, WebSocket: function () {},
    scheduleInboxReload: () => inboxReloads++ });
  vm.runInContext(`${fn('connectWs')}\n${fn('inboxEventChanges')}`, ctx); ctx.connectWs();
  const hear = (event) => ctx.S.ws.onmessage({ data: JSON.stringify(event) });
  assert.doesNotThrow(() => hear({ type: 'view.updated', taskId: 't', payload: { status: 'active' } }));
  assert.equal(ctx.S.liveUpdatesStale, true);
  assert.equal(inboxReloads, 0);
});
// The same rule left a background tab deaf to what asks for its person: no
// count in the tab title, no notification, no sound until they came back —
// which is when none of them is needed any more.
test('a hidden tab still hears what asks for its person, and only that', () => {
  let inboxReloads = 0;
  const ctx = vm.createContext({ noteRowAskEvent: () => {}, rowAskEpoch: 0, S: { meta: {}, inbox: [] }, document: { hidden: true }, location: { protocol: 'http:', host: 'test' }, WebSocket: function () {},
    scheduleInboxReload: () => inboxReloads++, applyChangeNotice: () => { throw new Error('a hidden page re-reads nothing else'); } });
  vm.runInContext(`${fn('connectWs')}\n${fn('inboxEventChanges')}`, ctx); ctx.connectWs();
  const hear = (event) => ctx.S.ws.onmessage({ data: JSON.stringify(event) });
  hear({ type: 'view.updated', taskId: 't', payload: { status: 'waiting', waitingFor: 'human' } });
  hear({ type: 'task.mentioned', taskId: 't', payload: {} });
  assert.equal(inboxReloads, 2);
  hear({ type: 'changed', area: 'inbox', own: true }); // read on another device: the title's count follows
  assert.equal(inboxReloads, 3);
  hear({ type: 'changed', area: 'task', taskId: 't', projectId: 'p' });
  hear({ type: 'agent.activity', taskId: 't', payload: {} });
  assert.equal(inboxReloads, 3);
  // The reload keeps the bell and its alerts; the sidebar and the list wait.
  const loadInbox = fn('loadInbox');
  assert.ok(loadInbox.indexOf('updateBell()') < loadInbox.indexOf('if (document.hidden)'));
  assert.ok(loadInbox.indexOf('if (document.hidden)') < loadInbox.indexOf('refreshForMeCounts()'));
});
test('RQ-12/UI-9: minimized onboarding does not poll', () => {
  let timers = 0;
  const ctx = vm.createContext({ noteRowAskEvent: () => {}, rowAskEpoch: 0, S: { onboarding: { display: 'minimized' } }, document: { hidden: false }, clearTimeout: () => {}, setTimeout: () => timers++ });
  vm.runInContext(fn('pollOnboarding'), ctx); ctx.pollOnboarding(); assert.equal(timers, 0);
});
test('RQ-10: retained payment controls are not fetched during every render', () => {
  assert.doesNotMatch(fn('wireTaskPage'), /refreshSpent/);
  assert.doesNotMatch(src, /\)\) payments\?\.refreshSpent/);
});
test('RQ-13: unchanged resource inventories survive view refreshes', async () => {
  let reads = 0;
  const ctx = vm.createContext({ noteRowAskEvent: () => {}, rowAskEpoch: 0, resourceReviewCache: new Map(), resourceInventoryCache: new Map(), api: async () => { reads++; return []; } });
  vm.runInContext(fn('loadResourceReview'), ctx);
  await ctx.loadResourceReview({ taskId: 't', stage: 'review', updatedAt: 1 }, false, true);
  await ctx.loadResourceReview({ taskId: 't', stage: 'review', updatedAt: 2 }, false, true);
  assert.equal(reads, 1);
  await ctx.loadResourceReview({ taskId: 't', stage: 'review', updatedAt: 2 }, true, true); assert.equal(reads, 2);
});
test('RQ-16: only the activity tab retains general event history', () => {
  const body = fn('connectWs');
  assert.match(body, /if \(S\.tab === 'activity'/);
  assert.ok(body.indexOf("if (S.tab === 'activity'") < body.indexOf('S.activity.unshift'));
});
