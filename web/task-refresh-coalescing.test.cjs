const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const start = src.indexOf('async function refreshTask(');
const fn = src.slice(start, src.indexOf('\n}', start) + 2);
test('RQ-2/UI-6: lifecycle bursts share a read and retain one trailing refresh', async () => {
  const reads = [], releases = [];
  const ctx = vm.createContext({ S: { selected: 't', projectId: 'p', tasks: [] },
    taskRecord: () => ({}), projectById: () => ({}), pendingCancellationView: v => v, renderTaskPage: () => {},
    api: url => { reads.push(url); return url === '/api/tasks/t' ? new Promise(r => releases.push(r)) : Promise.resolve([]); } });
  vm.runInContext(fn, ctx);
  const calls = Array.from({ length: 20 }, () => ctx.refreshTask('view.updated'));
  const views = () => reads.filter(url => url === '/api/tasks/t');
  assert.deepEqual(views(), ['/api/tasks/t']);
  releases.shift()({ taskId: 't' });
  for (let i = 0; i < 10 && !releases.length; i++) await new Promise(r => setImmediate(r));
  assert.deepEqual(views(), ['/api/tasks/t', '/api/tasks/t']);
  releases.shift()({ taskId: 't', title: 'latest' }); await Promise.all(calls);
  assert.equal(ctx.S.view.title, 'latest');
});
test('a lifecycle refresh re-resolves the widgets bound to the view', async () => {
  // The Overview's Progress section (stage, changed files) is resolved from the
  // view server-side; a stage change arrives only as `view.updated`.
  const reads = [];
  const ctx = vm.createContext({ S: { selected: 't', projectId: 'p', tasks: [] },
    taskRecord: () => ({}), projectById: () => ({}), pendingCancellationView: v => v, renderTaskPage: () => {},
    api: url => { reads.push(url); return Promise.resolve(url === '/api/tasks/t' ? { taskId: 't', stage: 'review' } : [{ widgets: [] }]); } });
  vm.runInContext(fn, ctx);
  await ctx.refreshTask('view.updated');
  assert.ok(reads.includes('/api/tasks/t/widgets'), reads.join(', '));
  reads.length = 0;
  await ctx.refreshTask('session.started');
  assert.deepEqual(reads.filter(url => url.endsWith('/widgets')), []);
});
test('LT-17: a sibling attempt\'s lifecycle refreshes the attempt cards, coalesced', async () => {
  const reads = [], releases = [];
  const src2 = (name) => { const at = src.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm')); return src.slice(at, src.indexOf('\n}', at) + 2); };
  const ctx = vm.createContext({ S: { projectId: 'p', selected: 'a', tab: 'tasks', tasks: [], taskEvents: [], activity: [], meta: {},
      attemptGroup: { principalAttemptId: 'a', attempts: [{ id: 'a' }, { id: 'b' }] } },
    location: { protocol: 'http:', host: 'test' }, WebSocket: function () {}, document: { hidden: false },
    patchTaskListFromEvent: () => false, patchSubTaskSummaryFromEvent: () => false, LIST_RELOAD_EVENTS: new Set(), inboxEventChanges: () => false, scheduleTaskListReload: () => {},
    taskRecord: () => ({}), projectById: () => ({}), pendingCancellationView: v => v, renderTaskPage: () => {},
    api: url => {
      reads.push(url);
      if (url === '/api/tasks/a/attempts') return new Promise(r => releases.push(r));
      return Promise.resolve(url === '/api/tasks/a' ? { taskId: 'a' } : []);
    } });
  vm.runInContext(fn, ctx);
  vm.runInContext(src2('connectWs'), ctx); ctx.connectWs();
  for (let i = 0; i < 20; i++) ctx.S.ws.onmessage({ data: JSON.stringify({ taskId: 'b', projectId: 'p', type: 'view.updated' }) });
  const attempts = () => reads.filter(url => url === '/api/tasks/a/attempts');
  assert.deepEqual(attempts(), ['/api/tasks/a/attempts']);
  // Only the sibling's cards changed: the open attempt's own details are not re-read.
  assert.deepEqual(reads.filter(url => /widgets|sessions/.test(url)), []);
  releases.shift()({ principalAttemptId: 'a', attempts: [{ id: 'a' }, { id: 'b', stage: 'review' }] });
  for (let i = 0; i < 10 && !releases.length; i++) await new Promise(r => setImmediate(r));
  assert.deepEqual(attempts(), ['/api/tasks/a/attempts', '/api/tasks/a/attempts']);
  releases.shift()({ principalAttemptId: 'a', attempts: [{ id: 'a' }, { id: 'b', stage: 'done' }] });
  await refreshSettled(ctx);
  assert.equal(ctx.S.attemptGroup.attempts[1].stage, 'done');
});
async function refreshSettled(ctx) {
  for (let i = 0; i < 20 && ctx.refreshTask.pending?.size; i++) await new Promise(r => setImmediate(r));
}
