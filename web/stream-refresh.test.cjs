const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const fn = (name) => { const start = src.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm')); return src.slice(start, src.indexOf('\n}', start) + 2); };
test('RQ-1: streaming output updates only its bubble and preserves activity history', () => {
  let renders = 0, bubbles = 0;
  const ctx = vm.createContext({ S: { selected: 't', tab: 'tasks', tasks: [], taskEvents: [{ type: 'agent.activity' }], activity: [], meta: {}, liveOutput: {} },
    location: { protocol: 'http:', host: 'test' }, WebSocket: function () {}, document: { hidden: false },
    patchTaskListFromEvent: () => false, patchSubTaskSummaryFromEvent: () => false, updateLiveBubble: () => bubbles++, scheduleTaskPageRender: () => renders++,
    LIST_RELOAD_EVENTS: new Set(), inboxEventChanges: () => false });
  vm.runInContext([fn('connectWs'), fn('noteLiveOutput'), fn('supersedesLiveOutput')].join('\n'), ctx); ctx.connectWs();
  for (let i = 0; i < 500; i++) ctx.S.ws.onmessage({ data: JSON.stringify({ taskId: 't', type: 'agent.output', payload: { text: 'hello', source: 'assistant' } }) });
  assert.equal(bubbles, 500); assert.equal(renders, 0); assert.equal(ctx.S.taskEvents.length, 1);
});
test('LT-5: the live bubble holds assistant text until its message completes or the attempt ends', () => {
  let bubbles = 0;
  const ctx = vm.createContext({ S: { selected: 't', tab: 'tasks', tasks: [], taskEvents: [], activity: [], meta: {}, liveOutput: {} },
    location: { protocol: 'http:', host: 'test' }, WebSocket: function () {}, document: { hidden: false },
    patchTaskListFromEvent: () => false, patchSubTaskSummaryFromEvent: () => false, updateLiveBubble: () => bubbles++, scheduleTaskPageRender: () => {},
    LIST_RELOAD_EVENTS: new Set(), inboxEventChanges: () => false });
  vm.runInContext([fn('connectWs'), fn('noteLiveOutput'), fn('supersedesLiveOutput')].join('\n'), ctx); ctx.connectWs();
  const send = (type, payload) => ctx.S.ws.onmessage({ data: JSON.stringify({ taskId: 't', type, payload }) });
  const live = (role = 'do') => ctx.S.liveOutput[role]?.text ?? '';
  send('agent.output', { role: 'do', text: 'Fixing the', source: 'assistant' });
  send('agent.output', { role: 'do', text: '$ npm test' });
  assert.equal(live(), 'Fixing the', 'tool lines never replace streamed text');
  send('agent.activity', { role: 'do', kind: 'command', phase: 'started', title: 'npm test' });
  assert.equal(live(), 'Fixing the', 'other timeline rows leave it in place');
  send('agent.activity', { role: 'do', kind: 'message', phase: 'completed', title: 'Fixing the loop' });
  assert.equal(live(), '', 'the completed message supersedes its live text');
  send('agent.output', { role: 'do', text: 'Half', source: 'assistant' });
  send('agent.activity', { role: 'do', kind: 'turn', phase: 'failed', title: 'Agent turn failed' });
  assert.equal(live(), '', 'a failed attempt voids its partial text');
  assert.equal(bubbles, 2);
});
// #396 review item 12: agents streaming at the same time keep their own text.
test('LT-5: each agent keeps its own live text; another agent\'s events never clear it', () => {
  const ctx = vm.createContext({ S: { selected: 't', tab: 'tasks', tasks: [], taskEvents: [], activity: [], meta: {}, liveOutput: {} },
    location: { protocol: 'http:', host: 'test' }, WebSocket: function () {}, document: { hidden: false },
    patchTaskListFromEvent: () => false, patchSubTaskSummaryFromEvent: () => false, updateLiveBubble: () => {}, scheduleTaskPageRender: () => {}, refreshTask: () => {},
    LIST_RELOAD_EVENTS: new Set(), inboxEventChanges: () => false });
  vm.runInContext([fn('connectWs'), fn('noteLiveOutput'), fn('supersedesLiveOutput')].join('\n'), ctx); ctx.connectWs();
  const send = (type, payload) => ctx.S.ws.onmessage({ data: JSON.stringify({ taskId: 't', type, payload }) });
  send('agent.output', { role: 'do', text: 'Editing the parser', source: 'assistant' });
  send('agent.output', { role: 'responder', text: 'The agent is', source: 'assistant' });
  send('agent.activity', { role: 'responder', kind: 'message', phase: 'completed', title: 'The agent is editing.' });
  send('agent.activity', { role: 'responder', kind: 'turn', phase: 'completed', title: 'Agent finished' });
  assert.equal(ctx.S.liveOutput.do?.text, 'Editing the parser');
  assert.equal(ctx.S.liveOutput.responder, undefined);
});
test('RQ-1: markdown renders are cached with bounded text size and option-sensitive keys', () => {
  let renders = 0;
  const ctx = vm.createContext({ globalThis: { KarmaxMarkdown: { renderMarkdown: (text, opts) => { renders++; return text + opts.math; } } }, Map });
  vm.runInContext(fn('renderMarkdown'), ctx);
  assert.equal(ctx.renderMarkdown('hello', { math: true }), 'hellotrue');
  ctx.renderMarkdown('hello', { math: true }); assert.equal(renders, 1);
  ctx.renderMarkdown('hello', { math: false }); assert.equal(renders, 2);
});
test('LT-5: streamed chunks stay out of the Activity feed', () => {
  let renders = 0;
  const ctx = vm.createContext({ S: { selected: null, tab: 'activity', projectId: 'p', tasks: [], taskEvents: [], activity: [], meta: {} },
    location: { protocol: 'http:', host: 'test' }, WebSocket: function () {}, document: { hidden: false },
    patchTaskListFromEvent: () => false, patchSubTaskSummaryFromEvent: () => false, bgRenderMain: () => renders++, LIST_RELOAD_EVENTS: new Set(), inboxEventChanges: () => false });
  vm.runInContext([fn('connectWs'), fn('noteLiveOutput'), fn('supersedesLiveOutput'), fn('liveOnlyEvent')].join('\n'), ctx); ctx.connectWs();
  for (let i = 0; i < 50; i++) ctx.S.ws.onmessage({ data: JSON.stringify({ taskId: 't', projectId: 'p', type: 'agent.output', payload: { text: `x${i}`, source: 'assistant' } }) });
  // Save progress is shown on the task, not listed either.
  ctx.S.ws.onmessage({ data: JSON.stringify({ taskId: 't', projectId: 'p', type: 'staging.progress', payload: { bytes: 1, totalBytes: 2 } }) });
  ctx.S.ws.onmessage({ data: JSON.stringify({ taskId: 't', projectId: 'p', type: 'agent.activity', payload: { kind: 'message', phase: 'completed' } }) });
  assert.equal(ctx.S.activity.length, 1); assert.equal(renders, 1);
});
