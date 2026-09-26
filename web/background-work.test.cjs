const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const fn = (name) => { const start = src.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm')); return src.slice(start, src.indexOf('\n}', start) + 2); };
test('RQ-11: hidden tabs defer websocket work until visibility returns', () => {
  const ctx = vm.createContext({ S: { meta: {} }, document: { hidden: true }, location: { protocol: 'http:', host: 'test' }, WebSocket: function () {} });
  vm.runInContext(fn('connectWs'), ctx); ctx.connectWs();
  assert.doesNotThrow(() => ctx.S.ws.onmessage({ data: JSON.stringify({ type: 'view.updated', taskId: 't' }) }));
  assert.equal(ctx.S.liveUpdatesStale, true);
});
test('RQ-12/UI-9: minimized onboarding does not poll', () => {
  let timers = 0;
  const ctx = vm.createContext({ S: { onboarding: { display: 'minimized' } }, document: { hidden: false }, clearTimeout: () => {}, setTimeout: () => timers++ });
  vm.runInContext(fn('pollOnboarding'), ctx); ctx.pollOnboarding(); assert.equal(timers, 0);
});
test('RQ-10: retained payment controls are not fetched during every render', () => {
  assert.doesNotMatch(fn('wireTaskPage'), /refreshSpent/);
  assert.doesNotMatch(src, /\)\) payments\?\.refreshSpent/);
});
test('RQ-13: unchanged resource inventories survive view refreshes', async () => {
  let reads = 0;
  const ctx = vm.createContext({ resourceReviewCache: new Map(), resourceInventoryCache: new Map(), api: async () => { reads++; return []; } });
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
