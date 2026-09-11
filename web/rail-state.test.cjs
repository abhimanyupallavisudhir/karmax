// The project rail should show selection only while a project-scoped page is
// open. Organization-wide pages retain projectId for context, but must not
// imply that the project itself is open. Also pins the rail's folder grouping
// (railProjectRows): implicit nested folders, collapse, and the collapsed
// folder that still shows the open project.
// Run: node web/rail-state.test.cjs
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

let html = '';
const rail = {
  contains: () => false,
  querySelector: () => null,
  querySelectorAll: () => [],
  set innerHTML(value) { html = value; },
  get innerHTML() { return html; },
};

let collapsed = [];
global.localStorage = { getItem: () => JSON.stringify(collapsed), setItem() {} };
global.$ = (selector) => selector === '#rail' ? rail : null;
global.document = { activeElement: null };
global.projectRoute = (id) => `/projects/${id}`;
global.projectPath = (project) => [project.folder, project.name].filter(Boolean).join('/');
global.globalRoute = (tab) => `/${tab}`;
global.esc = (value) => String(value);
global.ICON = { edit: '<svg></svg>', chevron: '<svg class="i-chevron"></svg>', project: '<svg class="i-project"></svg>', plus: '<svg class="i-plus"></svg>' };
global.wireProjectDrag = () => {};
global.newProject = () => {};
global.draggingProject = null;
global.editingRailItem = null;
// The tab list renderRail shares with renderMain (a module constant, not a function).
eval(src.match(/const PROJECT_SCOPED_TABS = \[[^\]]*\];/)[0].replace('const ', 'global.PROJECT_SCOPED_TABS = ').replace(/^global\.PROJECT_SCOPED_TABS = PROJECT_SCOPED_TABS = /, 'global.PROJECT_SCOPED_TABS = '));
global.S = {
  projectId: 'p1',
  organizationId: 'o1',
  projects: [{ id: 'p1', organizationId: 'o1', name: 'Alpha' }],
  tab: 'tasks',
};

eval(extractFn('railCollapsedFolders'));
eval(extractFn('railProjectRows'));
eval(extractFn('renderRail'));

let pass = 0;
let fail = 0;
const ok = (condition, message) => {
  if (condition) pass++;
  else { fail++; console.error('FAIL:', message); }
};

const projectRow = () => html.match(/<div class="proj project-row ([^"]*)"[^>]*data-id="p1"/)?.[1] || '';

renderRail();
ok(projectRow().includes('active'), 'the selected project is active on a project page');

for (const tab of ['dashboard', 'orgwiki', 'organization', 'profile', 'inbox']) {
  S.tab = tab;
  renderRail();
  ok(!projectRow().includes('active'), `the selected project is inactive on ${tab}`);
}

// ── folder grouping ──────────────────────────────────────────────────────────
S.tab = 'tasks';
S.projects = [
  { id: 'p1', organizationId: 'o1', name: 'Alpha' },
  { id: 'p2', organizationId: 'o1', name: 'Beta', folder: 'work' },
  { id: 'p3', organizationId: 'o1', name: 'Gamma', folder: 'work/clients' },
  { id: 'p4', organizationId: 'o2', name: 'Elsewhere', folder: 'work' },
];
renderRail();
ok(html.indexOf('data-id="p1"') < html.indexOf('data-folder="work"'),
  'a folder sits where its first project sits — after the loose project ahead of it');
const header = (path) => new RegExp(`<div class="proj folder[^"]*" data-folder="${path}"[^>]*style="--depth:(\\d)"`).exec(html);
ok(header('work')?.[1] === '0', 'the folder header renders at the top level');
ok(header('work/clients')?.[1] === '1', 'a nested folder header renders one level deeper');
ok(/data-id="p3"[^>]*style="--depth:2"/.test(html), 'a project in a subfolder indents below its header');
ok(!html.includes('p4'), "another organization's projects do not seed folders here");
ok(html.includes('data-project-edit="p3"') && html.includes('aria-label="Edit work/clients/Gamma"'),
  'every project row offers an edit action labelled with its full slash path');
ok(html.includes('data-folder-edit="work/clients"') && html.includes('aria-label="Rename work/clients"'),
  'every folder header offers its own rename action');

collapsed = ['work'];
renderRail();
ok(html.includes('data-folder="work"') && !html.includes('data-id="p2"') && !html.includes('work/clients'),
  'a collapsed folder hides its projects and subfolders but keeps its header');
ok(html.includes('data-id="p1"'), 'top-level projects are untouched by a collapse');

S.projectId = 'p3';
renderRail();
ok(html.includes('data-id="p3"') && !html.includes('data-id="p2"'),
  'a collapsed folder still shows the open project, and only that one');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
