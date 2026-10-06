const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const fn = (name) => { const start = src.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm')); assert.ok(start >= 0, name); return src.slice(start, src.indexOf('\n}', start) + 2); };
test('UI-25: malformed percent escapes do not break route parsing', () => {
  const ctx = vm.createContext({ URLSearchParams, DEFAULT_LIST_QUERY: 'for:me', ORG_VIEWS: {}, PROJECT_SCOPED_TABS: [], location: { pathname: '/', search: '' } });
  if (src.includes('function decodeRoutePart(')) vm.runInContext(fn('decodeRoutePart'), ctx);
  vm.runInContext(fn('parseRoute'), ctx);
  assert.doesNotThrow(() => ctx.parseRoute('/bad%ZZ/project'));
});
test('UI-33f: both project URL schemes read their tab from the one project tab list', () => {
  const list = src.match(/^const PROJECT_SCOPED_TABS = (\[[^\]]+\]);/m);
  assert.ok(list, 'PROJECT_SCOPED_TABS is declared');
  assert.ok(src.indexOf(list[0]) < src.indexOf('function parseRoute('), 'the list is declared before the router');
  assert.equal(src.split(list[1]).length, 2, 'the tab list is spelled out once');
  const ctx = vm.createContext({ URLSearchParams, DEFAULT_LIST_QUERY: 'for:me', ORG_VIEWS: {}, TASK_TABS: [], PROJECT_SCOPED_TABS: ['tasks', 'board'], fileRouteTarget: () => null });
  if (src.includes('function decodeRoutePart(')) vm.runInContext(fn('decodeRoutePart'), ctx);
  vm.runInContext(fn('parseRoute'), ctx);
  assert.equal(ctx.parseRoute('/org/project/board').tab, 'board');
  assert.equal(ctx.parseRoute('/projects/project/board').tab, 'board');
  assert.equal(ctx.parseRoute('/org/project/queue').tab, 'tasks');
});
