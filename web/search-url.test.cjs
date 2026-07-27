// Verifies that a search is a durable URL: the whole working query — free text,
// filters, grouping and sorting — round-trips through `?q=` on the tasks-list
// route, and the selected view chip is *derived* from that query rather than
// held as separate state (so a pasted/reloaded link lights the right chip).
// Run: node web/search-url.test.cjs
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

function extractFn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
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
eq(viewIdForQuery(''), null, 'the empty query is the “All” view');
eq(viewIdForQuery('   '), null, 'whitespace only is still “All”');
eq(viewIdForQuery('group:tag-type'), 'builtin:sectioned-type', 'a built-in view is recognised from its query');
eq(viewIdForQuery('sort:nextRun-asc is:scheduled'), 'builtin:scheduled', 'token order does not matter');
eq(viewIdForQuery('tag:bug'), 'V1', 'a saved view is recognised from its stringified query');
eq(viewIdForQuery('tag:bug priority:>=2'), null, 'an edited query no longer matches the view it came from');
eq(viewIdForQuery('status:active'), null, 'an ad-hoc query matches no view');

// ── applyRoute drives the list query from the URL ────────────────────────────
const applyRoute = extractFn('applyRoute');
ok(/S\.search = r\.q/.test(applyRoute), 'applyRoute seeds the list query from the route');

function ok(condition, message) {
  if (condition) pass++;
  else { fail++; console.error('FAIL:', message); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
