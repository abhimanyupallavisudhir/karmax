// Regression checks for "newer UI state wins" across overlapping async reads.
// These reproduce bugs previously reported after project/task switches and after
// mutations kicked off a refresh while an older refresh was still in flight.
// Run: node web/async-freshness.test.cjs
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

function extractFn(name) {
  const asyncStart = src.indexOf(`async function ${name}(`);
  const syncStart = src.indexOf(`function ${name}(`);
  const start = asyncStart >= 0 ? asyncStart : syncStart;
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0;
  const open = src.indexOf('{', start);
  for (let index = open; index < src.length; index++) {
    if (src[index] === '{') depth++;
    else if (src[index] === '}' && --depth === 0) return src.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

let passed = 0;
let failed = 0;
function ok(condition, message) {
  if (condition) passed++;
  else {
    failed++;
    console.error('FAIL:', message);
  }
}

global.S = {
  projectId: 'A',
  selected: null,
  tab: 'tasks',
  tasks: [{ id: 'a-current', projectId: 'A' }],
  deleted: new Set(),
  cancelling: new Set(),
  search: '',
  searchResult: null,
};
global.effectiveQuery = (query) => query;
global.bgRenderMain = () => {};
global.renderRail = () => {};
global.seedQueue = () => {};
global.renderTaskPage = () => {};
global.openTask = async () => {};
global.projectById = () => ({ organizationId: 'org' });
global.taskRecord = (id) => S.tasks.find((task) => task.id === id);
global.taskRefreshPromise = null;
global.taskRefreshQueued = false;

eval(extractFn('pendingCancellationView'));
eval(extractFn('pendingCancellationTask'));
eval(extractFn('loadTasks'));
eval(extractFn('filterDeletedFromSearchResult'));
eval(extractFn('runSearch'));
eval(extractFn('refreshTasks'));
eval(extractFn('refreshTask'));

(async () => {
  // A response from project A must not populate project B after navigation.
  const oldProject = deferred();
  global.api = () => oldProject.promise;
  const loadingA = loadTasks();
  S.projectId = 'B';
  S.tasks = [{ id: 'b-current', projectId: 'B' }];
  oldProject.resolve([{ id: 'a-stale', projectId: 'A' }]);
  await loadingA;
  ok(S.tasks[0].id === 'b-current', 'an old project task response cannot overwrite the current project');

  // Even within one project, an older response resolving last must not replace
  // the newer snapshot.
  S.projectId = 'B';
  const oldList = deferred();
  const freshList = deferred();
  let listCall = 0;
  global.api = () => (++listCall === 1 ? oldList.promise : freshList.promise);
  const oldLoad = loadTasks();
  const freshLoad = loadTasks();
  freshList.resolve([{ id: 'b-fresh', projectId: 'B' }]);
  await freshLoad;
  oldList.resolve([{ id: 'b-stale', projectId: 'B' }]);
  await oldLoad;
  ok(S.tasks[0].id === 'b-fresh', 'the latest task-list request wins when responses arrive out of order');

  // Search has the same race while a user types: the old query may be slower.
  const oldSearch = deferred();
  const freshSearch = deferred();
  global.api = (url) => url.includes('q=old') ? oldSearch.promise : freshSearch.promise;
  S.search = 'old';
  const searchingOld = runSearch();
  S.search = 'new';
  const searchingNew = runSearch();
  freshSearch.resolve({ tasks: [{ id: 'new-result' }] });
  await searchingNew;
  oldSearch.resolve({ tasks: [{ id: 'old-result' }] });
  await searchingOld;
  ok(S.searchResult.tasks[0].id === 'new-result', 'the latest search query wins when responses arrive out of order');

  // A search response already in flight when a draft is deleted must honor the
  // deletion tombstone instead of restoring the stale row after it resolves.
  const staleDeletedSearch = deferred();
  global.api = () => staleDeletedSearch.promise;
  S.deleted.add('deleted-draft');
  const searchingAcrossDelete = runSearch();
  staleDeletedSearch.resolve({ tasks: [{ id: 'deleted-draft' }, { id: 'kept-task' }], total: 2 });
  await searchingAcrossDelete;
  ok(S.searchResult.tasks.length === 1 && S.searchResult.tasks[0].id === 'kept-task',
    'an in-flight search cannot restore a deleted draft');
  ok(S.searchResult.total === 1, 'an in-flight search updates its total after filtering a deleted draft');
  S.deleted.clear();

  // A mutation-triggered refresh that arrives during an existing list refresh
  // must queue one follow-up read, otherwise it can only replay the pre-mutation
  // snapshot (e.g. a queued draft still looks like a draft).
  const firstRefresh = deferred();
  let refreshLoads = 0;
  S.tab = 'queue';
  global.api = async () => {
    refreshLoads++;
    if (refreshLoads === 1) await firstRefresh.promise;
    return [{ id: `refresh-${refreshLoads}`, projectId: S.projectId }];
  };
  const refreshing = refreshTasks();
  const mutationRefresh = refreshTasks();
  firstRefresh.resolve();
  await Promise.all([refreshing, mutationRefresh]);
  ok(refreshLoads === 2, 'a refresh requested mid-flight performs one follow-up read');

  // A task-A websocket refresh must not repaint task B if the user navigates
  // while task A's request is in flight.
  const staleTask = deferred();
  S.tasks = [
    { id: 'task-a', projectId: 'B' },
    { id: 'task-b', projectId: 'B' },
  ];
  S.selected = 'task-a';
  S.view = { taskId: 'task-a', title: 'A before' };
  global.api = (url) => url === '/api/tasks/task-a'
    ? staleTask.promise
    : Promise.resolve(url.includes('/attempts') ? null : url.includes('/sessions') ? {} : []);
  const refreshingTaskA = refreshTask();
  S.selected = 'task-b';
  S.view = { taskId: 'task-b', title: 'B current' };
  staleTask.resolve({ taskId: 'task-a', title: 'A stale' });
  await refreshingTaskA;
  ok(S.view.taskId === 'task-b', 'a stale task refresh cannot repaint a different selected task');

  // Multiple websocket events can refresh the same open task concurrently; the
  // last request, not the last network response, defines the visible state.
  const oldTaskView = deferred();
  const freshTaskView = deferred();
  let taskViewCall = 0;
  S.selected = 'task-a';
  S.view = { taskId: 'task-a', title: 'before' };
  global.api = (url) => {
    if (url === '/api/tasks/task-a') return ++taskViewCall === 1 ? oldTaskView.promise : freshTaskView.promise;
    return Promise.resolve(url.includes('/attempts') ? null : url.includes('/sessions') ? {} : []);
  };
  const oldTaskRefresh = refreshTask();
  const freshTaskRefresh = refreshTask();
  oldTaskView.resolve({ taskId: 'task-a', title: 'stale' });
  freshTaskView.resolve({ taskId: 'task-a', title: 'fresh' });
  await freshTaskRefresh;
  await oldTaskRefresh;
  ok(S.view.title === 'fresh', 'the latest refresh of one open task wins when responses arrive out of order');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
