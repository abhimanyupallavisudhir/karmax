// Links to the console's own pages that someone wrote — an agent's
// [#12](https://tavya.io/acme/site/tasks/12), a wiki page's link to a setting —
// open in place like the console's own links, and are never mistaken for files
// in a task's world; everything else (other sites, the API, shared files, the
// docs) keeps opening in a new tab.
// Run: node web/app-links.test.cjs
const fs = require('fs');
const path = require('path');
require('./markdown.js');

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
function extractFn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  // The body's brace, past default parameters such as `opts = {}`.
  let depth = 0, i = src.indexOf(') {', start) + 2;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`unterminated ${name}`);
}
function extractConst(name) {
  const start = src.indexOf(`const ${name} =`);
  if (start < 0) throw new Error(`${name} not found`);
  return src.slice(start, src.indexOf(';', start) + 1).replace(/^const /, '');
}

global.S = {
  organizations: [{ id: 'org_acme', name: 'Acme Inc', slug: 'acme', previousSlugs: ['acme-old'] }],
  projects: [{ id: 'proj_site', name: 'Web Site', organizationId: 'org_acme' }],
  tasks: [],
};
global.location = { href: 'https://tavya.io/acme/web-site/tasks/3', origin: 'https://tavya.io', pathname: '/acme/web-site/tasks/3', search: '' };
global.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
global.safeHref = (href) => href;
for (const name of ['TASK_TABS', 'TASK_TAB_ALIASES', 'DEFAULT_LIST_QUERY', 'ORG_VIEWS', 'PROJECT_SCOPED_TABS']) eval(extractConst(name));
for (const fn of ['taskTabOf', 'slugify', 'orgSlug', 'organizationBySlug', 'decodeRoutePart', 'fileRouteTarget', 'wikiViewFromQuery',
  'filesViewFromQuery', 'parseRoute', 'appRoutePath', 'isNewTabClick', 'installLinkRouter', 'renderMarkdown', 'renderConversationText',
  'worldFileTarget', 'worldFileHref']) eval(extractFn(fn));

let pass = 0, fail = 0;
const eq = (actual, expected, msg) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass++;
  else { fail++; console.error(`FAIL: ${msg}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`); }
};

// ── Which written links are pages of this console
eq(appRoutePath('https://tavya.io/acme/web-site/tasks/12'), '/acme/web-site/tasks/12', 'a task, as an agent links it');
eq(appRoutePath('/acme/web-site/tasks/12'), '/acme/web-site/tasks/12', 'the same as an absolute path');
eq(appRoutePath('https://tavya.io/acme/web-site/wiki#guides/deploy'), '/acme/web-site/wiki#guides/deploy', 'a wiki page keeps its entry');
eq(appRoutePath('https://tavya.io/acme/settings#settings-agents'), '/acme/settings#settings-agents', 'an organization setting keeps its card');
eq(appRoutePath('https://tavya.io/acme/proj_site/tasks/4'), '/acme/proj_site/tasks/4', 'another project named by its id');
eq(appRoutePath('https://tavya.io/acme-old/web-site'), '/acme-old/web-site', 'an organization\'s former slug still names it');
eq(appRoutePath('https://tavya.io/acme/web-site?q=is:open'), '/acme/web-site?q=is:open', 'a search keeps its query');
eq(appRoutePath('/profile'), '/profile', 'the profile');
eq(appRoutePath('/inbox'), '/inbox', 'the inbox');
eq(appRoutePath('https://github.com/acme/site/pull/3'), null, 'another site');
eq(appRoutePath('https://staging.tavya.io/acme/web-site/tasks/12'), null, 'another installation');
eq(appRoutePath('/api/projects/proj_site/files/raw?path=a'), null, 'the API');
eq(appRoutePath('/docs/agents'), null, 'the public docs');
eq(appRoutePath('/share/files/abc'), null, 'a shared file');
eq(appRoutePath('/'), null, 'the bare root');
eq(appRoutePath('//evil.example/acme'), null, 'a protocol-relative address');
eq(appRoutePath('reports/report.md'), null, 'a relative link cites a file in the task\'s world');
eq(appRoutePath('#section'), null, 'an in-page anchor');
eq(appRoutePath(undefined), null, 'no href');

// ── Rendered links carry the marker the router listens for
const md = renderMarkdown('See [#12](https://tavya.io/acme/web-site/tasks/12), [PR](https://github.com/a/b/pull/1) and [file](src/a.ts).');
eq(/<a href="https:\/\/tavya\.io\/acme\/web-site\/tasks\/12" data-app-link target="_blank"/.test(md), true, 'markdown marks an absolute link');
eq(/<a href="#" data-md-local="src\/a.ts">/.test(md), true, 'a relative file link is left to the world-file resolver');
eq(renderConversationText('[#12](https://tavya.io/acme/web-site/tasks/12)', 'agent', {}).includes('data-app-link'), true,
  'plain-text agent messages mark it too');

// ── A console page is never read as a file in the task's world
eq(worldFileHref('/acme/web-site/tasks/12', { taskId: 'task_3' }), null, 'a task path is not a file, even when the world path is unknown');

// ── A plain click routes in place; a new-tab click and other links are the browser's
const listeners = [];
global.document = { addEventListener: (type, fn) => listeners.push(fn) };
const visited = [];
global.spaNavigate = (href) => visited.push(href);
installLinkRouter();
const click = (attrs, extra = {}) => {
  const a = { hasAttribute: (n) => n in attrs, getAttribute: (n) => attrs[n] };
  const ev = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false, ...extra,
    target: { closest: (sel) => (sel.includes('data-app-link') && ('data-app-link' in attrs || 'data-spa' in attrs) ? a : null) },
    preventDefault() { this.defaultPrevented = true; } };
  listeners.forEach((fn) => fn(ev));
  return ev.defaultPrevented;
};
eq(click({ href: 'https://tavya.io/acme/web-site/tasks/12', 'data-app-link': '' }), true, 'a written task link routes in place');
eq(visited.at(-1), '/acme/web-site/tasks/12', '…to its in-app path');
eq(click({ href: 'https://github.com/a/b', 'data-app-link': '' }), false, 'another site opens as before');
eq(click({ href: 'https://tavya.io/acme/web-site/tasks/12', 'data-app-link': '' }, { metaKey: true }), false, '⌘-click still opens a new tab');
eq(click({ href: '/acme/web-site/queue', 'data-spa': '' }), true, 'the console\'s own links still route');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
