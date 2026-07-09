// Verifies draft deletion (deleteDraft + loadTasks in app.js) is not resurrected
// by a stale, in-flight task-list refresh. Reproduces the reported bug: deleting a
// draft made it disappear and instantly re-appear (a list GET issued before the
// DELETE landed clobbered the optimistic removal), and a second delete then hit an
// already-gone row and surfaced "no such task".
// Run: node web/draft-delete.test.cjs
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

// Pull a top-level function definition out of the browser script and eval it in
// this Node context. Its free identifiers (S, api, renderMain, toast) resolve to
// the globals we define below.
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

// ── Mock server + client globals the two functions close over ──────────────────
let serverList = [];           // authoritative task rows (as the store would hold them)
let pendingGets = [];          // resolvers for in-flight list GETs (to control ordering)
let toasts = [];

global.S = { projectId: 'proj', tasks: [], deleted: new Set(), forkPool: null };
global.renderMain = () => {};
global.toast = (msg, err) => { toasts.push({ msg, err: !!err }); };
global.api = (p, opts = {}) => {
  const method = (opts.method || 'GET').toUpperCase();
  if (method === 'DELETE') {
    const id = p.split('/').pop();
    const existed = serverList.some((t) => t.id === id);
    serverList = serverList.filter((t) => t.id !== id);
    return existed ? Promise.resolve({ ok: true }) : Promise.reject(new Error('no such task'));
  }
  // GET list: snapshot the server state *now*, but only resolve when released — so a
  // test can issue a GET, mutate the server, then deliver the stale snapshot late.
  const snapshot = serverList.slice();
  return new Promise((resolve) => pendingGets.push(() => resolve(snapshot)));
};
const releaseGet = () => pendingGets.shift()();

eval(extractFn('loadTasks'));
eval(extractFn('deleteDraft'));

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('FAIL:', msg); } };
const has = (id) => S.tasks.some((t) => t.id === id);

(async () => {
  const d1 = { id: 'task_d1', title: 'draft one', params: { draft: true } };
  const t2 = { id: 'task_t2', title: 'running', params: {} };
  serverList = [d1, t2];
  S.tasks = [d1, t2];

  // 1. A background refresh fires first (ws debounce / auto-save) and snapshots the
  //    list *including* the draft — but its response hasn't arrived yet.
  const stale = loadTasks();

  // 2. User deletes the draft. It vanishes from the list and is tombstoned.
  await deleteDraft('task_d1');
  ok(!has('task_d1'), 'draft removed from the list after delete');
  ok(has('task_t2'), 'the unrelated running task is untouched');
  ok(S.deleted.has('task_d1'), 'deleted draft id is tombstoned');

  // 3. The stale GET now resolves with the pre-delete list. THE BUG: without the
  //    tombstone this overwrites S.tasks and the draft re-appears.
  releaseGet();
  await stale;
  ok(!has('task_d1'), 'stale in-flight refresh does NOT resurrect the deleted draft');

  // 4. A fresh refresh (server has caught up, list no longer contains it) retires
  //    the tombstone so the set can't grow without bound.
  const fresh = loadTasks();
  releaseGet();
  await fresh;
  ok(!S.deleted.has('task_d1'), 'tombstone retired once the server confirms deletion');
  ok(!has('task_d1'), 'draft stays gone after a clean refresh');

  // 5. Deleting an already-gone draft is a no-op success, not a scary error toast.
  toasts = [];
  serverList = [t2];
  S.tasks = [{ id: 'task_d3', title: 'gone', params: { draft: true } }, t2]; // stale client copy
  await deleteDraft('task_d3');
  ok(!toasts.some((t) => t.err), 'deleting an already-removed draft surfaces no error toast');
  ok(!has('task_d3'), 'the stale draft is dropped locally too');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
