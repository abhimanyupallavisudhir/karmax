// Verifies that switching projects (applyRoute in app.js) drops the previous
// project's per-project view state — the working query, the last search result and
// the roving cursor — instead of bleeding it into the newly-opened project.
// Reproduces the reported bug: creating/opening another project still showed the
// old project's tasks/view because applyRoute re-ran the previous query against the
// new project and never cleared the stale state. Also pins the durable-URL contract:
// on the tasks list the query comes from the route (?q=), not from memory.
// Run: node web/project-switch.test.cjs
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

// Pull a top-level `async function` definition out of the browser script and eval
// it here; its free identifiers resolve to the globals defined below.
function extractFn(name) {
  const start = src.indexOf(`async function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0, i = src.indexOf('{', start);
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`unterminated ${name}`);
}

// ── Mocks for everything applyRoute closes over ────────────────────────────────
let calls = [];
global.location = { pathname: '/projects/b/tasks', search: '' };
global.currentPath = () => location.pathname + location.search;
global.parseRoute = () => ({ name: 'project', slug: 'b', tab: 'tasks', taskKey: null, q: '' });
global.projectBySlug = (slug) => (slug === 'b' ? { id: 'B', name: 'B' } : null);
global.go = () => { calls.push('go'); };
global.toast = () => { calls.push('toast'); };
global.loadTasks = async () => { calls.push('loadTasks'); S.tasks = [{ id: 't_new', projectId: S.projectId }]; };
global.loadOrg = async () => { calls.push(`loadOrg:${S.projectId}`); S.orgProjectId = S.projectId; S.views = [{ id: 'vB' }]; };
global.loadOrganizationRuntimeCatalog = async () => {};
global.runSearch = async () => { calls.push('runSearch'); S.searchResult = { tasks: S.tasks }; };
global.renderRail = () => { calls.push('renderRail'); };
global.renderMain = () => { calls.push('renderMain'); };
global.seedActivity = () => {};
global.seedQueue = () => {};
global.renderDashboard = () => {};
global.resolveProjectTaskKey = async () => null;
global.openTask = async () => {};
global.renderTaskPage = () => {};
global.closeTaskDom = () => { calls.push('closeTaskDom'); };

// Previous project 'A' with a live query, a stale search result and a roving
// cursor — none of which belong to project 'B'.
global.S = {
  projectId: 'A',
  tasks: [{ id: 't_old', projectId: 'A' }],
  search: 'status:running assignee:me',
  searchResult: { tasks: [{ id: 't_old' }] },
  cursorId: 't_old',
  orgProjectId: 'A',
  views: [{ id: 'vA' }],
  tab: 'tasks',
  selected: null,
};

eval(extractFn('applyRoute'));

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('FAIL:', msg); } };

(async () => {
  await applyRoute();

  // The switch actually happened and loaded the new project's data.
  ok(S.projectId === 'B', 'projectId switched to the opened project');
  ok(calls.includes('loadTasks'), 'new project tasks were loaded');
  ok(calls.includes('loadOrg:B'), 'new project tags/views were loaded (not left stale)');
  ok(calls.includes('runSearch'), 'the task list was re-evaluated for the new project');

  // The previous project's view state is gone — this is the bug being fixed.
  ok(S.search === '', 'the previous project query was cleared');
  ok(S.cursorId === null, 'the previous project roving cursor was cleared');
  // searchResult must not survive as the OLD project's result. runSearch repopulates
  // it for the new project; what matters is it no longer references t_old.
  ok(!(S.searchResult?.tasks || []).some((t) => t.id === 't_old'), 'the previous project search result did not bleed through');

  // Same-project navigation must NOT reset the cursor, and the list query is
  // whatever the URL says — a link into a search paints that search.
  calls = [];
  S.search = 'stale'; S.cursorId = 't_new';
  global.parseRoute = () => ({ name: 'project', slug: 'b', tab: 'tasks', taskKey: null, q: 'tag:bug sort:priority-desc' });
  await applyRoute();
  ok(S.projectId === 'B', 'staying on the same project keeps it selected');
  ok(S.search === 'tag:bug sort:priority-desc', 'the list query comes from the URL, not from memory');
  ok(S.cursorId === 't_new', 'same-project navigation preserves the roving cursor');

  // A task permalink carries no ?q= (it is about the task): it must leave the
  // working query alone so closing the task returns to the same filtered list.
  global.parseRoute = () => ({ name: 'project', slug: 'b', tab: 'tasks', taskKey: '7', q: '' });
  global.resolveProjectTaskKey = async () => 't7';
  await applyRoute();
  ok(S.search === 'tag:bug sort:priority-desc', 'opening a task does not wipe the list query');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
