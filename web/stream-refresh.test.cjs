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
  for (let i = 0; i < 500; i++) ctx.S.ws.onmessage({ data: JSON.stringify({ taskId: 't', type: 'agent.output', payload: { text: 'hello', source: 'assistant' } }) });
  assert.equal(bubbles, 500); assert.equal(renders, 0); assert.equal(ctx.S.taskEvents.length, 1);
});
test('LT-5: the live bubble holds assistant text until its message completes or the attempt ends', () => {
  let bubbles = 0;
  const ctx = vm.createContext({ S: { selected: 't', tab: 'tasks', tasks: [], taskEvents: [], activity: [], meta: {} },
    location: { protocol: 'http:', host: 'test' }, WebSocket: function () {}, document: { hidden: false },
    patchTaskListFromEvent: () => false, updateLiveBubble: () => bubbles++, scheduleTaskPageRender: () => {},
    LIST_RELOAD_EVENTS: new Set(), inboxEventChanges: () => false });
  vm.runInContext(fn('connectWs'), ctx); ctx.connectWs();
  const send = (type, payload) => ctx.S.ws.onmessage({ data: JSON.stringify({ taskId: 't', type, payload }) });
  send('agent.output', { text: 'Fixing the', source: 'assistant' });
  send('agent.output', { text: '$ npm test' });
  assert.equal(ctx.S.liveOutput, 'Fixing the', 'tool lines never replace streamed text');
  send('agent.activity', { kind: 'command', phase: 'started', title: 'npm test' });
  assert.equal(ctx.S.liveOutput, 'Fixing the', 'other timeline rows leave it in place');
  send('agent.activity', { kind: 'message', phase: 'completed', title: 'Fixing the loop' });
  assert.equal(ctx.S.liveOutput, '', 'the completed message supersedes its live text');
  send('agent.output', { text: 'Half', source: 'assistant' });
  send('agent.activity', { kind: 'turn', phase: 'failed', title: 'Agent turn failed' });
  assert.equal(ctx.S.liveOutput, '', 'a failed attempt voids its partial text');
  assert.equal(bubbles, 2);
});
test('RQ-1: markdown renders are cached with bounded text size and option-sensitive keys', () => {
  let renders = 0;
  const ctx = vm.createContext({ globalThis: { TavyaMarkdown: { renderMarkdown: (text, opts) => { renders++; return text + opts.math; } } }, Map });
  vm.runInContext(fn('renderMarkdown'), ctx);
  assert.equal(ctx.renderMarkdown('hello', { math: true }), 'hellotrue');
  ctx.renderMarkdown('hello', { math: true }); assert.equal(renders, 1);
  ctx.renderMarkdown('hello', { math: false }); assert.equal(renders, 2);
});
test('LT-5: streamed chunks stay out of the Activity feed', () => {
  let renders = 0;
  const ctx = vm.createContext({ S: { selected: null, tab: 'activity', projectId: 'p', tasks: [], taskEvents: [], activity: [], meta: {} },
    location: { protocol: 'http:', host: 'test' }, WebSocket: function () {}, document: { hidden: false },
    patchTaskListFromEvent: () => false, bgRenderMain: () => renders++, LIST_RELOAD_EVENTS: new Set(), inboxEventChanges: () => false });
  vm.runInContext(fn('connectWs'), ctx); ctx.connectWs();
  for (let i = 0; i < 50; i++) ctx.S.ws.onmessage({ data: JSON.stringify({ taskId: 't', projectId: 'p', type: 'agent.output', payload: { text: `x${i}`, source: 'assistant' } }) });
  ctx.S.ws.onmessage({ data: JSON.stringify({ taskId: 't', projectId: 'p', type: 'agent.activity', payload: { kind: 'message', phase: 'completed' } }) });
  assert.equal(ctx.S.activity.length, 1); assert.equal(renders, 1);
});
