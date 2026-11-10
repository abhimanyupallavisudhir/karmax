const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const fn = (name) => { const start = src.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm')); return src.slice(start, src.indexOf('\n}', start) + 2); };

// A write made elsewhere (another tab, a phone, a colleague, an agent) records
// no task event for most routes — archive, tags, priority, notes, a saved view,
// reading an inbox ask — so the page kept showing what was true before. The
// gateway now says which task, project and organization each write addressed.
function page(state = {}) {
  const calls = [];
  const note = (name) => (...args) => { calls.push(args.length ? [name, ...args] : [name]); };
  const timers = [];
  const ctx = vm.createContext({
    S: { tab: 'tasks', projectId: 'p', organizationId: 'o', selected: null, inbox: [], view: null, attemptGroup: null, ...state },
    api: Object.assign(async (url) => { calls.push([url]); return {}; }, { defaults: new Map([['kept', 1]]) }), calls,
    scheduleInboxReload: note('inbox'), refreshTask: note('task'), scheduleHomeRefresh: note('home'), scheduleTaskListReload: note('list'),
    loadProjects: async () => { calls.push(['projects']); }, loadOrganizations: async () => {}, renderRail: note('rail'),
    isTaskListTab: () => ['tasks', 'home', 'inbox'].includes(ctx.S.tab), refreshForMeCounts: () => {}, scheduleTaskPageRender: note('task page'), loadOrg: async () => { calls.push(['tags+views']); return true; },
    loadOrgViews: async () => { calls.push(['org views']); }, bgRenderMain: note('render'),
    taskRecord: (id) => (state.records || {})[id],
    setTimeout: (run) => { timers.push(run); return timers.length; },
  });
  vm.runInContext(`let structureReload = null;\n${['applyChangeNotice', 'changeTouchesOpenTask', 'scheduleStructureReload', 'isCrossProjectList'].map(fn).join('\n')}`, ctx);
  return { ctx, calls, timers, notice: (notice) => { calls.length = 0; ctx.applyChangeNotice({ type: 'changed', area: 'task', organizationId: 'o', ...notice }); return calls.map((call) => call.join(' ')); } };
}

test('a task written elsewhere re-reads the list that may show it, and nothing of other projects', () => {
  const list = page();
  assert.deepEqual(list.notice({ projectId: 'p', taskId: 't' }), ['list']);
  assert.equal(list.ctx.api.defaults.size, 0, "reads kept until this tab's next write are stale after anyone's");
  assert.deepEqual(list.notice({ projectId: 'other', taskId: 'x' }), []);
  const home = page({ tab: 'home' });
  assert.deepEqual(home.notice({ projectId: 'other', taskId: 'x' }), ['home'], 'the organization home lists every project');
  assert.deepEqual(home.notice({ organizationId: 'elsewhere', projectId: 'q', taskId: 'y' }), []);
  const bell = page({ tab: 'inbox' });
  assert.deepEqual(bell.notice({ organizationId: 'elsewhere', projectId: 'q', taskId: 'y' }), ['home'], "the bell's page spans organizations");
});

test('the open task re-reads itself for a write to it, its sub-tasks, its parent or its other attempts', () => {
  const open = page({ selected: 't', view: { subTaskSummaries: [{ id: 'child' }] }, attemptGroup: { attempts: [{ id: 't' }, { id: 'sibling' }] },
    records: { t: { parentTaskId: 'parent' } } });
  // Its record (tags, priority, notes, archived) comes with its attempt group.
  for (const taskId of ['t', 'child', 'sibling', 'parent'])
    assert.deepEqual(open.notice({ projectId: 'p', taskId }), ['task changed attempt', 'list'], taskId);
  assert.deepEqual(open.notice({ projectId: 'p', taskId: 'unrelated' }), ['list']);
  assert.match(fn('refreshTask'), /has\(\/attempt\|/, 'the "attempt" reason reloads the record');
});

test('an ask the inbox holds follows a write to its task; my own read state follows me across tabs', () => {
  const holding = page({ inbox: [{ taskId: 't' }] });
  assert.deepEqual(holding.notice({ projectId: 'p', taskId: 't' }), ['inbox', 'list']);
  assert.deepEqual(holding.notice({ projectId: 'p', taskId: 'x' }), ['list']);
  assert.deepEqual(page({ tab: 'settings' }).notice({ area: 'inbox', own: true }), ['inbox'], 'read on my phone: the bell here follows');
  assert.deepEqual(page({ tab: 'settings' }).notice({ area: 'user', own: true }), ['/api/user/preferences'], 'a preference that follows me to every device');
  const made = page({ tab: 'settings' });
  assert.deepEqual(made.notice({ area: 'organization', own: true, organizationId: undefined }), []);
  assert.equal(made.timers.length, 1, 'an organization I made elsewhere: the sidebar reads again');
});

test('a write to the project or organization itself re-reads the sidebar and the list chrome, coalesced', async () => {
  const list = page();
  assert.deepEqual(list.notice({ area: 'project', projectId: 'p' }), ['list']);
  list.ctx.applyChangeNotice({ type: 'changed', area: 'project', organizationId: 'o' });
  assert.equal(list.timers.length, 1, 'one reload for the burst');
  list.calls.length = 0;
  await list.timers[0]();
  assert.deepEqual(list.calls.map((call) => call.join(' ')), ['projects', 'rail', 'tags+views', 'render']);
  // A page with a form (settings) keeps what is being typed: only the sidebar moves.
  const settings = page({ tab: 'settings' });
  settings.notice({ area: 'project', projectId: 'p' });
  settings.calls.length = 0;
  await settings.timers[0]();
  assert.deepEqual(settings.calls.map((call) => call.join(' ')), ['projects', 'rail', 'tags+views']);
  const home = page({ tab: 'home' });
  home.notice({ area: 'task' });
  home.calls.length = 0;
  await home.timers[0]();
  assert.deepEqual(home.calls.map((call) => call.join(' ')), ['projects', 'rail', 'org views', 'render']);
});

test('the socket hands notices over, drops them while hidden like events, and names this tab', () => {
  const notices = [];
  const urls = [];
  const document = { hidden: false };
  const ctx = vm.createContext({ S: { clientId: 'tab_abcdefgh', projectId: 'p', tab: 'tasks', tasks: [], taskEvents: [], activity: [], meta: {} },
    location: { protocol: 'https:', host: 'example.test' }, WebSocket: function (url) { urls.push(url); }, document,
    applyChangeNotice: (notice) => notices.push(notice), patchTaskListFromEvent: () => { throw new Error('a notice is not an event'); } });
  vm.runInContext(`${fn('connectWs')}\n${fn('isCrossProjectList')}\n${fn('inboxEventChanges')}`, ctx);
  ctx.connectWs();
  assert.deepEqual(urls, ['wss://example.test/ws?client=tab_abcdefgh']);
  ctx.S.ws.onmessage({ data: JSON.stringify({ type: 'changed', area: 'task', taskId: 't' }) });
  assert.equal(notices.length, 1);
  document.hidden = true;
  ctx.S.ws.onmessage({ data: JSON.stringify({ type: 'changed', area: 'task', taskId: 't' }) });
  assert.equal(notices.length, 1);
  assert.equal(ctx.S.liveUpdatesStale, true, 'coming back reads again');
  assert.match(fn('fetchApi'), /'x-tavya-client': S\.clientId/, 'requests carry the tab, so it is not told of its own writes');
});

test('coming back to the page reads again after a long absence, even when nothing was heard', () => {
  let now = 1_000_000;
  const calls = [];
  const timers = [];
  const document = { hidden: false };
  const ctx = vm.createContext({ S: { selected: null, tab: 'home', liveUpdatesStale: false, onboarding: null }, document,
    Date: { now: () => now }, api: { defaults: new Map() }, resourceReviewCache: new Map(), resourceInventoryCache: new Map(),
    checkWsLiveness: (force) => calls.push(`ping ${force}`), reconnectWs: () => calls.push('reconnect'),
    loadInbox: async () => { calls.push('inbox'); }, scheduleHomeRefresh: () => calls.push('home'), refreshTasks: () => calls.push('list'),
    readAsksOnScreen: () => calls.push('read'), checkConsoleRevision: () => {}, isCrossProjectList: () => true,
    setTimeout: (run, ms) => { timers.push([run, ms]); } });
  vm.runInContext(`const AWAY_REFRESH_MS = 15_000; const RESUME_PONG_WAIT_MS = 3_000; let hiddenSince = 0; let wsPingSentAt = 0;\n${fn('resumeVisibleUpdates')}`, ctx);
  const away = (ms) => { document.hidden = true; ctx.resumeVisibleUpdates(); now += ms; document.hidden = false; calls.length = 0; ctx.resumeVisibleUpdates(); return [...calls]; };
  assert.deepEqual(away(2_000), ['ping true', 'read'], 'a glance away re-reads nothing');
  // A phone froze the page: no message arrived to mark it stale, and the socket may be dead.
  assert.deepEqual(away(60_000), ['ping true', 'inbox', 'home']);
  assert.equal(timers.at(-1)[1], 3_000, 'and the socket has three seconds to answer, not the next liveness tick');
  vm.runInContext('wsPingSentAt = 1', ctx);
  timers.at(-1)[0]();
  assert.equal(calls.at(-1), 'reconnect');
  ctx.S.liveUpdatesStale = true;
  assert.deepEqual(away(1_000), ['ping true', 'inbox', 'home'], 'something was dropped while hidden');
});

test('the inbox changing re-reads the list on screen, and reads what arrived about the open task first', async () => {
  const calls = [];
  let response = [{ id: 'a', kind: 'mentioned', unread: true, urgency: 'normal', taskId: 't' }];
  const ctx = vm.createContext({ S: { organizations: [{ id: 'o' }], tab: 'home', selected: null, inbox: [] }, Map, document: { hidden: false },
    api: async () => response, urgencyRank: () => 1, inboxArrivals: (seen, items) => (seen ? items.filter((item) => item.unread && !seen.has(item.id)) : []),
    announceInbox: (items) => calls.push(`announce ${items.map((item) => item.id).join(',')}`), updateBell: () => {}, refreshForMeCounts: () => {},
    scheduleHomeRefresh: () => calls.push('bell page'), refreshListQuietly: () => calls.push('list'),
    readAsksOnScreen: () => { calls.push('read on screen'); if (ctx.S.selected) for (const item of ctx.S.inbox) if (item.taskId === ctx.S.selected) item.unread = false; } });
  vm.runInContext(`${fn('loadInbox')}\n${fn('inboxState')}`, ctx);
  await ctx.loadInbox();
  assert.deepEqual(calls, ['read on screen', 'announce '], 'the first load is the list’s own first read');
  calls.length = 0;
  await ctx.loadInbox();
  assert.deepEqual(calls, ['read on screen', 'announce '], 'nothing changed, nothing re-read');
  response = [{ ...response[0], unread: false }];
  calls.length = 0;
  await ctx.loadInbox();
  assert.deepEqual(calls, ['read on screen', 'announce ', 'list'], 'read elsewhere: the row leaves For me here');
  // A mention arriving for the task being looked at is read, not announced.
  ctx.S.selected = 't2';
  response = [...response, { id: 'b', kind: 'mentioned', unread: true, urgency: 'normal', taskId: 't2' }];
  calls.length = 0;
  await ctx.loadInbox();
  assert.deepEqual(calls.slice(0, 2), ['read on screen', 'announce ']);
});
