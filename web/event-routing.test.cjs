const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const fn = (name) => { const start = src.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm')); return src.slice(start, src.indexOf('\n}', start) + 2); };
test('RQ-3/UI-7: foreign projects and known sibling attempts do not reload the current list', () => {
  let reloads = 0;
  const ctx = vm.createContext({ S: { projectId: 'p', selected: null, tab: 'tasks', tasks: [], taskEvents: [], activity: [], meta: {}, attemptGroup: { principalAttemptId: 'a', attempts: [{ id: 'a' }, { id: 'b' }] } },
    location: { protocol: 'http:', host: 'test' }, WebSocket: function () {}, document: { hidden: false },
    patchTaskListFromEvent: () => false, patchSubTaskSummaryFromEvent: () => false, LIST_RELOAD_EVENTS: new Set(['subtask.created']), inboxEventChanges: () => false, scheduleTaskListReload: () => reloads++ });
  vm.runInContext(fn('connectWs'), ctx); ctx.connectWs();
  for (const event of [{ taskId: 'foreign', projectId: 'other', type: 'view.updated' }, { taskId: 'foreign', projectId: 'other', type: 'subtask.created' }, { taskId: 'b', projectId: 'p', type: 'view.updated' }]) ctx.S.ws.onmessage({ data: JSON.stringify(event) });
  assert.equal(reloads, 0);
});
test('RQ-3: a non-principal attempt the list never shows does not reload it', () => {
  let reloads = 0;
  const ctx = vm.createContext({ S: { projectId: 'p', selected: null, tab: 'tasks', tasks: [{ id: 'a' }], taskEvents: [], activity: [], meta: {}, attemptGroup: null },
    location: { protocol: 'http:', host: 'test' }, WebSocket: function () {}, document: { hidden: false },
    patchTaskListFromEvent: () => false, patchSubTaskSummaryFromEvent: () => false, LIST_RELOAD_EVENTS: new Set(), inboxEventChanges: () => false, scheduleTaskListReload: () => reloads++ });
  vm.runInContext(fn('connectWs'), ctx); ctx.connectWs();
  ctx.S.ws.onmessage({ data: JSON.stringify({ taskId: 'b', projectId: 'p', type: 'view.updated', siblingAttempt: true, payload: { status: 'active' } }) });
  assert.equal(reloads, 0);
  ctx.S.ws.onmessage({ data: JSON.stringify({ taskId: 'c', projectId: 'p', type: 'view.updated', payload: { status: 'active' } }) });
  assert.equal(reloads, 1, 'an unseen principal task still reloads the list');
});
test('RQ-16: the socket says which project and task this tab shows, once per change', () => {
  const sent = [];
  function WebSocket() { this.readyState = 1; this.send = (data) => sent.push(JSON.parse(data)); }
  WebSocket.OPEN = 1;
  const ctx = vm.createContext({ S: { projectId: 'p', selected: null }, location: { protocol: 'http:', host: 'test' }, WebSocket, document: { hidden: false },
    setWsOnline: () => {}, checkConsoleRevision: () => {}, wsHadDropped: false });
  vm.runInContext(`${fn('connectWs')}\n${fn('syncLiveWatch')}`, ctx); ctx.connectWs();
  ctx.S.ws.onopen();
  ctx.S.selected = 't'; ctx.syncLiveWatch(); ctx.syncLiveWatch();
  ctx.S.selected = null; ctx.S.projectId = 'q'; ctx.syncLiveWatch();
  assert.deepEqual(sent, [
    { type: 'watch', projectId: 'p', taskId: null },
    { type: 'watch', projectId: 'p', taskId: 't' },
    { type: 'watch', projectId: 'q', taskId: null },
  ]);
  for (const name of ['openTask', 'closeTaskDom', 'applyRoute']) assert.match(fn(name), /syncLiveWatch\(\)/, `${name} keeps the watch current`);
});
test('RQ-8: inbox reloads only for potential actionable or outcome changes', () => {
  const ctx = vm.createContext({ S: { inbox: [{ taskId: 'known' }] } }); vm.runInContext(fn('inboxEventChanges'), ctx);
  const event = payload => ({ type: 'view.updated', taskId: 't', payload });
  assert.equal(ctx.inboxEventChanges(event({ status: 'active', waitingFor: 'agentSlot' })), false);
  assert.equal(ctx.inboxEventChanges(event({ status: 'done' })), true);
  assert.equal(ctx.inboxEventChanges(event({ status: 'waiting', waitingFor: 'human' })), true);
  assert.equal(ctx.inboxEventChanges({ ...event({ status: 'active' }), taskId: 'known' }), true);
});
test('RQ-15: task list refreshes do not rebuild the project rail', () => {
  assert.doesNotMatch(fn('connectWs'), /renderRail\(\)/);
  assert.doesNotMatch(fn('refreshTasks'), /renderRail\(\)/);
});
