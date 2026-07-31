// The project rail should show selection only while a project-scoped page is
// open. Organization-wide pages retain projectId for context, but must not
// imply that the project itself is open.
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
  set innerHTML(value) { html = value; },
  get innerHTML() { return html; },
};

global.$ = (selector) => selector === '#rail' ? rail : null;
global.document = { activeElement: null };
global.projectRoute = (id) => `/projects/${id}`;
global.globalRoute = (tab) => `/${tab}`;
global.esc = (value) => String(value);
global.wireProjectDrag = () => {};
global.newProject = () => {};
global.draggingProject = null;
global.S = {
  projectId: 'p1',
  organizationId: 'o1',
  projects: [{ id: 'p1', organizationId: 'o1', name: 'Alpha' }],
  tab: 'tasks',
};

eval(extractFn('renderRail'));

let pass = 0;
let fail = 0;
const ok = (condition, message) => {
  if (condition) pass++;
  else { fail++; console.error('FAIL:', message); }
};

const projectRow = () => html.match(/<a class="proj ([^"]*)"[^>]*data-id="p1"/)?.[1] || '';

renderRail();
ok(projectRow().includes('active'), 'the selected project is active on a project page');

for (const tab of ['dashboard', 'orgwiki', 'organization', 'profile', 'inbox']) {
  S.tab = tab;
  renderRail();
  ok(!projectRow().includes('active'), `the selected project is inactive on ${tab}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
