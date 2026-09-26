const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const fn = (name) => { const start = src.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm')); return src.slice(start, src.indexOf('\n}', start) + 2); };
test('RQ-1: streaming output updates only its bubble and preserves activity history', () => {
  let renders = 0, bubbles = 0;
  const ctx = vm.createContext({ S: { selected: 't', tab: 'tasks', tasks: [], taskEvents: [{ type: 'agent.activity' }], activity: [], meta: {} },
    location: { protocol: 'http:', host: 'test' }, WebSocket: function () {}, document: { hidden: false },
    patchTaskListFromEvent: () => false, updateLiveBubble: () => bubbles++, scheduleTaskPageRender: () => renders++,
    LIST_RELOAD_EVENTS: new Set(), inboxEventChanges: () => false });
  vm.runInContext(fn('connectWs'), ctx); ctx.connectWs();
  for (let i = 0; i < 500; i++) ctx.S.ws.onmessage({ data: JSON.stringify({ taskId: 't', type: 'agent.output', payload: { text: 'hello' } }) });
  assert.equal(bubbles, 500); assert.equal(renders, 0); assert.equal(ctx.S.taskEvents.length, 1);
});
test('RQ-1: markdown renders are cached with bounded text size and option-sensitive keys', () => {
  let renders = 0;
  const ctx = vm.createContext({ globalThis: { TavyaMarkdown: { renderMarkdown: (text, opts) => { renders++; return text + opts.math; } } }, Map });
  vm.runInContext(fn('renderMarkdown'), ctx);
  assert.equal(ctx.renderMarkdown('hello', { math: true }), 'hellotrue');
  ctx.renderMarkdown('hello', { math: true }); assert.equal(renders, 1);
  ctx.renderMarkdown('hello', { math: false }); assert.equal(renders, 2);
});
