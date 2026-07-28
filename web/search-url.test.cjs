// Verifies that a search is a durable URL: the whole working query — free text,
// filters, grouping and sorting — round-trips through `?q=` on the tasks-list
// route, and the selected view chip is *derived* from that query rather than
// held as separate state (so a pasted/reloaded link lights the right chip).
// Run: node web/search-url.test.cjs
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

function extractFn(name) {
  let start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  if (src.slice(start - 6, start) === 'async ') start -= 6; // keep `async` so `await` inside parses
  let depth = 0;
  const body = src.indexOf('{', start);
  for (let i = body; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}
function extractConst(name) {
  const start = src.indexOf(`const ${name} =`);
  if (start < 0) throw new Error(`${name} not found`);
  const end = src.indexOf(';', start);
  return src.slice(start, end + 1).replace(/^const /, '');
}

// ── State the helpers close over ─────────────────────────────────────────────
const S = {
  organizations: [{ id: 'org_acme', name: 'Acme Inc', slug: 'acme' }, { id: 'org_globex', name: 'Globex', slug: 'globex' }],
  projects: [
    { id: 'P1', name: 'Website Redesign', organizationId: 'org_acme' },
    { id: 'P2', name: 'Mobile App', organizationId: 'org_globex' },
  ],
  organizationId: 'org_acme',
  projectId: 'P1',
  search: '',
  tasks: [{ id: 'T9', projectId: 'P1', num: 42 }],
  // The field registry the query parser consults (a trimmed copy of the server's).
  fields: [
    { key: 'is', type: 'facet' },
    { key: 'status', type: 'enum' },
    { key: 'tag', type: 'enum' },
    { key: 'priority', type: 'number' },
  ],
  views: [{ id: 'V1', name: 'Bugs', query: { filters: [{ field: 'tag', op: 'is', values: ['bug'] }] } }],
};
global.S = S;

eval(extractConst('TASK_TABS'));
eval(extractConst('ORG_VIEWS'));
eval(extractConst('BUILTIN_VIEWS'));
eval(extractFn('slugify'));
eval(extractFn('projectSlug'));
eval(extractFn('projectById'));
eval(extractFn('orgSlug'));
eval(extractFn('organizationById'));
eval(extractFn('currentOrg'));
eval(extractFn('orgBase'));
eval(extractFn('parseRoute'));
eval(extractFn('projectBase'));
eval(extractFn('projectRoute'));
eval(extractFn('globalRoute'));
eval(extractFn('encodeQuery'));
eval(extractFn('taskRecord'));
eval(extractFn('taskUrl'));
eval(extractFn('stringifyQuery'));
eval(extractFn('parseQueryClient'));
eval(extractFn('normalizeQuery'));
eval(extractConst('ALL_VIEW'));
eval(extractFn('viewIdForQuery'));
global.location = { pathname: '/', search: '' };

let pass = 0, fail = 0;
const eq = (actual, expected, msg) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) pass++;
  else { fail++; console.error(`FAIL: ${msg}\n  expected ${e}\n  got      ${a}`); }
};

// ── the query is in the URL ──────────────────────────────────────────────────
eq(parseRoute('/acme/website-redesign').q, '', 'a bare list URL carries no query');
eq(parseRoute('/acme/website-redesign?q=status:active+tag:bug').q, 'status:active tag:bug',
  'the ?q= param is the working query ("+" decodes back to a space)');
eq(parseRoute('/acme/website-redesign?q=group%3Atag-type').q, 'group:tag-type', 'percent-encoded queries decode too');
eq(parseRoute('/acme/website-redesign?q=x').tab, 'tasks', 'a query does not disturb tab parsing');
eq(parseRoute('/acme/website-redesign/queue?q=x').tab, 'queue', 'nor a non-default tab');
eq(parseRoute('/acme/website-redesign/tasks/42?q=x').taskKey, '42', 'nor a task permalink');

// ── URL builders carry it ────────────────────────────────────────────────────
eq(projectRoute('P1', 'tasks', 'status:active tag:bug'), '/acme/website-redesign?q=status:active+tag:bug',
  'an explicit query is appended, readably');
eq(projectRoute('P1', 'tasks', ''), '/acme/website-redesign', 'an empty query adds no param');
eq(projectRoute('P1', 'queue', 'status:active'), '/acme/website-redesign/queue',
  'only the tasks list is query-driven; other tabs stay clean');
S.search = 'group:tag-type';
eq(projectRoute('P1'), '/acme/website-redesign?q=group:tag-type',
  'links to the current project keep the working query, so navigating around never loses it');
eq(projectRoute('P2'), '/globex/mobile-app', 'another project does not inherit this one’s query');
eq(taskUrl('T9'), '/acme/website-redesign/tasks/42', 'a task permalink stays clean and shareable');
S.search = '';

// ── round trip, including characters that need escaping ──────────────────────
for (const q of [
  'status:active tag:bug',
  'group:tag-type sort:priority-desc',
  'is:scheduled sort:nextRun-asc "merge conflict" priority:>=2',
  'tag:a,b #42 100% & done?',
]) {
  eq(parseRoute(projectRoute('P1', 'tasks', q)).q, q, `round-trips through the URL: ${q}`);
}

// ── the selected view chip is derived from the query ─────────────────────────
eq(viewIdForQuery(''), '__all__', 'the empty query is the “All” view');
eq(viewIdForQuery('   '), '__all__', 'whitespace only is still “All”');
eq(viewIdForQuery('group:tag-type'), 'builtin:sectioned-type', 'a built-in view is recognised from its query');
eq(viewIdForQuery('sort:nextRun-asc is:scheduled'), 'builtin:scheduled', 'token order does not matter');
eq(viewIdForQuery('tag:bug'), 'V1', 'a saved view is recognised from its stringified query');
eq(viewIdForQuery('tag:bug priority:>=2'), null, 'an edited query no longer matches the view it came from');
eq(viewIdForQuery('status:active'), null, 'an ad-hoc query matches no view — and is not “All” either, since it IS filtered');

function ok(condition, message) {
  if (condition) pass++;
  else { fail++; console.error('FAIL:', message); }
}

// ── the chips read the query, so a pasted URL paints the right one ───────────
// viewIdForQuery is exercised above; this pins that viewsBar() actually consumes
// it, which is what makes deleting the separate S.activeView state safe.
global.esc = (s) => String(s ?? ''); // escaping is not what this test is about
eval(extractFn('viewsBar'));
const activeChips = (q) => {
  S.search = q;
  return (viewsBar().match(/<div class="view-chip[^"]*active[^"]*"[^>]*>/g) || [])
    .map((c) => (c.match(/data-view="([^"]+)"/) || [])[1]);
};
eq(activeChips('tag:bug'), ['V1'], 'a URL naming a saved view’s query lights that chip');
eq(activeChips('sort:nextRun-asc is:scheduled'), ['builtin:scheduled'], 'and a built-in view’s, whatever the token order');
eq(activeChips(''), ['__all__'], 'an empty query lights “All”');
eq(activeChips('tag:bug priority:>=2'), [], 'an ad-hoc query lights nothing');
S.search = '';

// ── the address bar follows the query (the write direction) ──────────────────
// The read direction (URL → list query, via applyRoute) is executed for real in
// project-switch.test.cjs; here we execute the other half — editing a search must
// actually rewrite the address bar, or none of the above URLs ever come to exist.
const nav = []; // every history entry written, in order, as `push|replace path`
global.history = {
  replaceState: (_s, _t, p) => { nav.push(`replace ${p}`); setLocation(p); },
  pushState: (_s, _t, p) => { nav.push(`push ${p}`); setLocation(p); },
};
function setLocation(p) {
  const [pathname, search = ''] = String(p).split('?');
  location.pathname = pathname;
  location.search = search ? `?${search}` : '';
}
setLocation('/acme/website-redesign');

let rendered = 0, searched = 0;
const box = { value: '' }; // the topbar search input
global.$ = (sel) => (sel === '#task-search' ? box : null);
global.runSearch = async () => { searched++; };
global.renderMain = () => { rendered++; };
global.currentPath = () => location.pathname + location.search;
eval(extractFn('syncQueryUrl'));
eval(extractFn('setQuery'));

(async () => {
  S.tab = 'tasks'; S.selected = null; S.projectId = 'P1'; S.search = '';

  await setQuery('status:active tag:bug');
  eq(currentPath(), '/acme/website-redesign?q=status:active+tag:bug', 'picking a filter puts the search in the address bar');
  eq(box.value, 'status:active tag:bug', 'and in the search box');
  ok(searched === 1 && rendered === 1, 'the list is re-evaluated and repainted once');
  eq(nav, ['replace /acme/website-redesign?q=status:active+tag:bug'],
    'refining a search replaces the entry rather than burying the page behind one per keystroke');

  await setQuery('status:active tag:bug group:tag-type sort:priority-desc');
  eq(currentPath(), '/acme/website-redesign?q=status:active+tag:bug+group:tag-type+sort:priority-desc',
    'grouping and sorting live in the same durable query');

  // Re-issuing the identical query must not churn history.
  const before = nav.length;
  await setQuery('status:active tag:bug group:tag-type sort:priority-desc');
  eq(nav.length, before, 'an unchanged query writes no new history entry');

  await setQuery('');
  eq(currentPath(), '/acme/website-redesign', 'clearing the search clears the param — no dangling ?q=');

  // Only the tasks list is query-driven: nothing else may hijack the URL.
  S.search = 'tag:bug';
  for (const [label, patch] of [
    ['an open task', { selected: 'T9' }],
    ['another tab', { tab: 'queue' }],
    ['no project', { projectId: null }],
  ]) {
    setLocation('/acme/website-redesign/queue');
    Object.assign(S, { tab: 'tasks', selected: null, projectId: 'P1' }, patch);
    syncQueryUrl();
    eq(currentPath(), '/acme/website-redesign/queue', `the query does not rewrite the URL from ${label}`);
  }

  // ── list → task → back lands on the same search ────────────────────────────
  Object.assign(S, { tab: 'tasks', selected: null, projectId: 'P1', search: '', returnRoute: null, view: null });
  global.go = async (p, opts = {}) => { nav.push(`${opts.replace ? 'replace' : 'push'} ${p}`); setLocation(p); };
  global.globalRoute = () => '/acme/dashboard';
  global.closeTaskFormPage = () => {};
  eval(extractFn('spaNavigate'));
  eval(extractFn('closeTask'));

  await setQuery('tag:bug sort:priority-desc');
  const listUrl = currentPath();
  await spaNavigate(taskUrl('T9'));
  eq(currentPath(), '/acme/website-redesign/tasks/42', 'opening a task navigates to its clean permalink');
  eq(S.returnRoute, listUrl, 'the search we came from is remembered');
  S.selected = 'T9';
  await closeTask();
  eq(currentPath(), listUrl, 'closing the task returns to the very same filtered, sorted list');

  // Even with no remembered route (a task opened by pasted permalink, then a
  // search typed on the way back out) the query in hand still rebuilds the URL.
  S.returnRoute = null; S.selected = 'T9'; S.search = 'is:archived';
  await closeTask();
  eq(currentPath(), '/acme/website-redesign?q=is:archived', 'the fallback back-link carries the query too');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
