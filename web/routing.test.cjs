// Verifies the URL scheme in app.js: organization-owned pages live under their
// organization's slug, the user-owned profile is global, project/task permalinks
// nest beneath their organization, and pre-organization URLs still parse so they
// can be canonicalised to the current form.
// Run: node web/routing.test.cjs
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

// Pull a top-level `function`/`const` definition out of the browser script and eval
// it here; its free identifiers resolve to the globals defined below.
function extractFn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0, i = src.indexOf('{', start);
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`unterminated ${name}`);
}
// Strip the `const` keyword so a direct sloppy-mode eval assigns the value to a
// global (block-scoped `const`/`let` would not leak out of the eval).
function extractConst(name) {
  const start = src.indexOf(`const ${name} =`);
  if (start < 0) throw new Error(`${name} not found`);
  const end = src.indexOf(';', start);
  return src.slice(start, end + 1).replace(/^const /, '');
}

// ── State the routing helpers close over ──────────────────────────────────────
const S = {
  organizations: [
    { id: 'org_acme', name: 'Acme Inc', slug: 'acme' },
    { id: 'org_globex', name: 'Globex', slug: 'globex' },
  ],
  projects: [
    { id: 'P1', name: 'Website Redesign', organizationId: 'org_acme' },
    { id: 'P2', name: 'Mobile App', organizationId: 'org_globex' },
    // A project whose slug collides with another org's project name, to prove
    // slug resolution is org-scoped.
    { id: 'P3', name: 'Mobile App', organizationId: 'org_acme' },
  ],
  organizationId: 'org_acme',
  projectId: 'P1',
  attemptGroup: { attempts: [] },
  tasks: [{ id: 'T9', projectId: 'P1', num: 42 }],
};
global.S = S;

// Bring the real declarations into scope.
eval(extractConst('TASK_TABS'));
eval(extractConst('DEFAULT_LIST_QUERY'));
eval(extractConst('ORG_VIEWS'));
eval(extractConst('PROJECT_SCOPED_TABS'));
eval(extractFn('slugify'));
eval(extractFn('projectSlug'));
eval(extractFn('projectById'));
eval(extractFn('firstProjectForOrganization'));
eval(extractFn('projectBySlug'));
eval(extractFn('orgSlug'));
eval(extractFn('organizationById'));
eval(extractFn('organizationBySlug'));
eval(extractFn('currentOrg'));
eval(extractFn('syncOrganizationSwitcher'));
eval(extractFn('orgBase'));
eval(extractFn('fileRouteTarget'));
eval(extractFn('parseRoute'));
eval(extractFn('wikiViewFromQuery'));
eval(extractFn('wikiRoute'));
eval(extractFn('projectBase'));
eval(extractFn('projectRoute'));
eval(extractFn('listRoute'));
eval(extractFn('homeRoute'));
eval(extractFn('encodeQuery'));
eval(extractFn('globalRoute'));
eval(extractFn('organizationLandingRoute'));
eval(extractFn('installationRoute'));
eval(extractFn('profileRoute'));
eval(extractFn('taskRecord'));
eval(extractFn('taskUrl'));
global.location = { pathname: '/' };

let pass = 0, fail = 0;
const eq = (actual, expected, msg) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) pass++;
  else { fail++; console.error(`FAIL: ${msg}\n  expected ${e}\n  got      ${a}`); }
};

// ── URL builders produce the org-scoped scheme ────────────────────────────────
eq(projectRoute('P1'), '/acme/website-redesign', 'project tasks route omits the tasks segment');
eq(projectRoute('P1', 'queue'), '/acme/website-redesign/queue', 'a non-default project tab is appended');
eq(projectRoute('P1', 'settings'), '/acme/website-redesign/settings', 'project settings route');
eq(projectRoute('P2'), '/globex/mobile-app', 'project route uses the project’s OWN org, not the current one');
eq(firstProjectForOrganization('org_globex')?.id, 'P2', 'project fallback skips an earlier project from another organization');
eq(firstProjectForOrganization('org_missing'), undefined, 'project fallback does not borrow a project from another organization');
eq(taskUrl('T9'), '/acme/website-redesign/tasks/42', 'task permalink nests under /<org>/<project>/tasks/:num');
eq(globalRoute('insights'), '/acme/insights', 'insights route is org-prefixed');
eq(globalRoute('organization'), '/acme/settings', 'internal tab "organization" → URL segment "settings"');
eq(globalRoute('inbox'), '/acme/inbox', 'inbox route is org-prefixed');
eq(installationRoute(), '/installation', 'installation route is global, not org-prefixed');
eq(profileRoute(), '/profile', 'profile route is user-scoped, not org-prefixed');
eq(globalRoute('organization', organizationById('org_globex')), '/globex/settings', 'globalRoute honours an explicit org');
eq(organizationLandingRoute('org_globex'), '/globex', 'switching organizations lands on the selected organization\'s home');
eq(homeRoute(), '/acme', 'the organization home is the bare organization path (its default view is for:me)');
eq(homeRoute(organizationById('org_globex'), ''), '/globex?q=', '"All" on the home is spelled out as an empty query');
eq(homeRoute(organizationById('org_globex'), 'project:mobile-app'), '/globex?q=project:mobile-app', 'a home query rides in ?q=');
eq(projectRoute('P1', 'tasks', ''), '/acme/website-redesign?q=', '"All" on a project list is bookmarkable');
eq(projectRoute('P1', 'tasks', 'for:me'), '/acme/website-redesign', 'the default for:me list is the bare path');
S.organizationId = 'org_globex';
eq(profileRoute(), '/profile', 'profile route is stable when a different organization is selected');
const organizationSwitcher = { value: 'org_acme', _sync() { this.value = currentOrg().id; } };
global.$ = (selector) => selector === '#org-switcher' ? organizationSwitcher : null;
syncOrganizationSwitcher();
eq(organizationSwitcher.value, 'org_globex', 'the persistent top-left picker follows the active organization');
S.organizationId = 'org_acme';

// ── parseRoute round-trips the new scheme ─────────────────────────────────────
eq(parseRoute('/acme/insights'), { name: 'global', org: 'acme', tab: 'insights' }, 'parse /<org>/insights');
eq(parseRoute('/acme/dashboard'), { name: 'global', org: 'acme', tab: 'insights', legacy: true }, 'old /<org>/dashboard bookmarks land on insights');
eq(parseRoute('/acme/settings'), { name: 'global', org: 'acme', tab: 'organization' }, 'parse /<org>/settings');
eq(parseRoute('/acme/inbox'), { name: 'global', org: 'acme', tab: 'inbox', sub: null }, 'parse /<org>/inbox');
eq(parseRoute('/acme/inbox/review-requested'), { name: 'global', org: 'acme', tab: 'inbox', sub: 'review-requested' },
  'parse /<org>/inbox/<kind> as the inbox pinned to one kind of notification');
eq(parseRoute('/profile'), { name: 'profile' }, 'parse the global user profile');
eq(parseRoute('/installation'), { name: 'installation' }, 'parse the operator-owned installation page');
eq(parseRoute('/globex/profile'), { name: 'profile', legacy: true },
  'an old org-prefixed profile URL canonicalises without selecting that organization');
eq(parseRoute('/acme'), { name: 'global', org: 'acme', tab: 'home', q: 'for:me' }, 'parse bare /<org> as the organization home, for:me by default');
eq(parseRoute('/acme?q='), { name: 'global', org: 'acme', tab: 'home', q: '' }, 'an empty ?q= is the home\'s "All" view');
eq(parseRoute('/acme?q=project:app+status:waiting').q, 'project:app status:waiting', 'the home carries its query');
eq(parseRoute('/acme/website-redesign'),
  { name: 'project', org: 'acme', slug: 'website-redesign', tab: 'tasks', taskKey: null, taskTab: null, q: 'for:me' },
  'parse /<org>/<project> as the tasks tab');
eq(parseRoute('/acme/website-redesign/queue'),
  { name: 'project', org: 'acme', slug: 'website-redesign', tab: 'queue', taskKey: null, taskTab: null, q: 'for:me' },
  'parse a project tab');
eq(parseRoute('/acme/website-redesign/activity'),
  { name: 'project', org: 'acme', slug: 'website-redesign', tab: 'activity', taskKey: null, taskTab: null, q: 'for:me' },
  'the hidden Activity debugger remains reachable by direct URL');
eq(parseRoute('/acme/website-redesign/tasks/42'),
  { name: 'project', org: 'acme', slug: 'website-redesign', tab: 'tasks', taskKey: '42', taskTab: null, q: 'for:me' },
  'parse a task permalink');
eq(parseRoute('/acme/website-redesign/tasks/42/file?path=%2Fworkspace%2Fapp%2Fmain.ts&line=17'),
  { name: 'project', org: 'acme', slug: 'website-redesign', tab: 'tasks', taskKey: '42', taskTab: null, q: 'for:me',
    taskFile: { path: '/workspace/app/main.ts', line: 17 } },
  'parse a task-scoped file handoff permalink');
eq(parseRoute('/acme/website-redesign/tasks/42/checkin'),
  { name: 'project', org: 'acme', slug: 'website-redesign', tab: 'tasks', taskKey: '42', taskTab: 'checkin', q: 'for:me' },
  'parse a task permalink pinned to a tab');

// ── Wiki routes (org-level bottom-left link + project tab) ────────────────────
eq(globalRoute('orgwiki'), '/acme/wiki', 'internal tab "orgwiki" → URL segment "wiki"');
eq(parseRoute('/acme/wiki'), { name: 'global', org: 'acme', tab: 'orgwiki' }, 'parse /<org>/wiki as the organization wiki');
eq(projectRoute('P1', 'wiki'), '/acme/website-redesign/wiki', 'project wiki route');
// The wiki's branch view is part of its URL (task 367: it had none).
eq(wikiRoute('P1', 'task:367', 'reviews/2026-09-26'), '/acme/website-redesign/wiki?task=367#reviews%2F2026-09-26', 'a task view with an open entry');
eq(wikiRoute('P1', 'branch:feature/x'), '/acme/website-redesign/wiki?branch=feature%2Fx', 'a branch view');
eq(wikiRoute('P1', ''), '/acme/website-redesign/wiki', 'the default branch has the plain wiki URL');
eq(parseRoute('/acme/website-redesign/wiki?task=367').wikiView, 'task:367', 'a task view parses back');
eq(parseRoute('/acme/website-redesign/wiki?branch=feature%2Fx').wikiView, 'branch:feature/x', 'a branch view parses back');
eq(parseRoute('/acme/website-redesign/wiki').wikiView, undefined, 'the default view carries no selector');
eq(parseRoute('/acme/website-redesign/queue?task=367').wikiView, undefined, 'only the wiki reads a view');
eq(parseRoute('/acme/website-redesign/wiki'),
  { name: 'project', org: 'acme', slug: 'website-redesign', tab: 'wiki', taskKey: null, taskTab: null, q: 'for:me' },
  'parse a project wiki tab');

// ── Round-trip: build → parse → resolve ───────────────────────────────────────
const r = parseRoute(projectRoute('P2'));
eq(organizationBySlug(r.org)?.id, 'org_globex', 'built project route resolves back to its org');
eq(projectBySlug(r.slug, organizationBySlug(r.org).id)?.id, 'P2', 'and back to the project within that org');

// ── Org-scoped slug resolution (collision across orgs) ────────────────────────
eq(projectBySlug('mobile-app', 'org_acme')?.id, 'P3', 'same slug resolves per-org (acme)');
eq(projectBySlug('mobile-app', 'org_globex')?.id, 'P2', 'same slug resolves per-org (globex)');
eq(projectBySlug('P2', 'org_acme'), undefined, 'a raw project id cannot escape the organization named in the URL');

// ── Legacy URLs still parse and are flagged for canonicalisation ──────────────
eq(parseRoute('/dashboard'), { name: 'global', tab: 'insights', legacy: true }, 'legacy /dashboard');
eq(parseRoute('/organization'), { name: 'global', tab: 'organization', legacy: true }, 'legacy /organization');
eq(parseRoute('/settings'), { name: 'global', tab: 'organization', legacy: true }, 'legacy /settings alias');
eq(parseRoute('/inbox'), { name: 'global', tab: 'inbox', sub: null, legacy: true }, 'legacy /inbox');
eq(parseRoute('/projects/website-redesign/tasks/42'),
  { name: 'project', slug: 'website-redesign', tab: 'tasks', taskKey: '42', taskTab: null, q: 'for:me', legacy: true },
  'legacy /projects/:name/tasks/:num');
eq(parseRoute('/invite'), { name: 'invite' }, 'invite stays a top-level route');
eq(parseRoute('/'), { name: 'home' }, 'root is home');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
