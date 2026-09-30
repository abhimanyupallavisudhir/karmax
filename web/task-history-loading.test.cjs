const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
function extract(name) {
  let start = src.indexOf(`function ${name}(`);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  const end = src.indexOf('\n}', start) + 2;
  return src.slice(start, end);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function main() {
  const history = deferred(), sessions = deferred();
  const paints = [];
  const view = { taskId: 'task', messages: [{ role: 'user', text: 'review' }] };
  const event = { seq: 10, type: 'agent.activity', payload: { role: 'do', kind: 'message', title: 'Findings' } };
  const c = vm.createContext({
    S: { tasks: [], organizationId: 'org' }, term: null,
    DEFAULT_EXPLANATION_SETTINGS: {},
    taskRecord: () => ({ projectId: 'project', params: {} }),
    projectById: () => ({ organizationId: 'org' }),
    renderTaskLoadingPage: () => {},
    renderTaskPage: () => { if (c.S.view) paints.push(c.S.taskEvents.length); },
    pendingCancellationView: v => v, defaultTaskTab: () => 'checkin',
    scheduleTaskPageRender: () => c.renderTaskPage(),
    loadParamDefaults: async () => ({}), toast: message => { throw new Error(message); },
    api: async url => {
      if (url.endsWith('/events?since=0&limit=300')) return history.promise;
      if (url.split('?')[0].endsWith('/sessions')) return sessions.promise;
      if (url === '/api/tasks/task') return view;
      if (url.endsWith('/explanation-settings')) return { effective: {} };
      return [];
    },
  });
  vm.runInContext(['mergeTaskHistory', 'refreshTaskHistory', 'showDraftPage', 'openTask'].map(extract).join('\n'), c);
  let opened = false;
  const opening = c.openTask('task', 'checkin').then(() => { opened = true; });
  await tick();
  assert.equal(c.S.taskHistoryLoading, true);
  history.resolve([event]);
  await tick();
  assert.equal(opened, false, 'unrelated session lookup is still pending');
  assert.equal(paints.at(-1), 1, 'history paints before unrelated resources finish');
  assert.equal(c.S.taskHistoryLoading, false);
  sessions.resolve({});
  await opening;
  assert.equal(c.S.taskEvents.length, 1, 'final hydration does not duplicate history');

  const older = deferred(), newer = deferred();
  let calls = 0;
  c.api = () => (++calls === 1 ? older.promise : newer.promise);
  const first = c.refreshTaskHistory('task'), second = c.refreshTaskHistory('task');
  newer.resolve([{ ...event, seq: 11 }]);
  await second;
  older.resolve([{ ...event, seq: 9 }]);
  await first;
  assert.equal(c.S.taskEvents.some(e => e.seq === 9), false, 'late superseded history does not overwrite a newer load');

  // The new attempt links open execution IDs. A → B → A must retain the
  // latest A transcript even when the first A history arrives last.
  const staleAttemptHistory = deferred();
  let attemptReads = 0;
  c.api = async url => {
    if (url.endsWith('/events?since=0&limit=300')) {
      if (url.includes('/attempt-a/') && ++attemptReads === 1) return staleAttemptHistory.promise;
      return [{ ...event, taskId: url.includes('/attempt-a/') ? 'attempt-a' : 'attempt-b', seq: 30 }];
    }
    if (url === '/api/tasks/attempt-a' || url === '/api/tasks/attempt-b')
      return { ...view, taskId: url.split('/').pop() };
    if (url.endsWith('/explanation-settings')) return { effective: {} };
    return [];
  };
  const staleAttempt = c.openTask('attempt-a', 'checkin', true);
  await tick();
  await c.openTask('attempt-b', 'checkin', true);
  await c.openTask('attempt-a', 'checkin', true);
  staleAttemptHistory.resolve([{ ...event, taskId: 'attempt-a', seq: 9 }]);
  await staleAttempt;
  assert.equal(c.S.view.taskId, 'attempt-a');
  assert.equal(c.S.viewingAttempt, 'attempt-a', 'the selected execution remains pinned');
  assert.equal(c.S.taskEvents.length, 1);
  assert.equal(c.S.taskEvents[0].seq, 30, 'the reopened attempt keeps its new history');
  assert.equal(c.S.taskEvents[0].taskId, 'attempt-a', 'another attempt’s conversation does not bleed through');
  c.S.selected = 'task';

  c.api = async () => { throw new Error('offline'); };
  await c.refreshTaskHistory('task');
  assert.equal(c.S.taskHistoryError, 'offline');
  assert.equal(c.S.taskHistoryLoading, false);
  assert.ok(c.S.taskEvents.length, 'a failed reload preserves already visible conversation');

  let backfills = 0, inboxReloads = 0;
  Object.assign(c, {
    location: { protocol: 'https:', host: 'example.test' },
    WebSocket: function () {}, setWsOnline() {}, checkConsoleRevision() {},
    refreshTasks: async () => {}, refreshTask: async () => {},
    loadInbox: async () => { inboxReloads++; },
    refreshTaskHistory: async id => { assert.equal(id, 'task'); backfills++; },
    wsHadDropped: true,
  });
  vm.runInContext(extract('connectWs'), c);
  c.connectWs();
  c.S.ws.onopen();
  assert.equal(backfills, 1, 'reconnect reloads missed conversation events');
  assert.equal(inboxReloads, 1, 'reconnect reloads missed inbox notifications');
  c.S.ws.onopen();
  assert.equal(backfills, 1, 'ordinary connection open does not reload history');
  assert.equal(inboxReloads, 1, 'ordinary connection open does not reload the inbox');
  console.log('Task history loading, request races, errors, and reconnect backfill passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
