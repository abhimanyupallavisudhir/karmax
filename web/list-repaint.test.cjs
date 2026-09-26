const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const fn = (name) => { const start = src.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm')); return src.slice(start, src.indexOf('\n}', start) + 2); };
test('RQ-7: background search paints once, after the result arrives', async () => {
  let callback, finish, renders = 0;
  const ctx = vm.createContext({ S: { tab: 'tasks' }, searchDebounce: null, clearTimeout: () => {}, setTimeout: f => { callback = f; }, syncQueryUrl: () => {}, renderMain: () => renders++, bgRenderMain: () => renders++, runSearch: () => new Promise(r => { finish = r; }) });
  vm.runInContext(fn('scheduleSearch'), ctx); ctx.scheduleSearch(true);
  const pending = callback(); assert.equal(renders, 0); finish(); await pending; assert.equal(renders, 1);
});
test('RQ-5: cached settings navigation paints once', () => {
  assert.match(fn('applyRoute'), /if \(canPaintCachedProject && tab !== 'tasks'\) return;/);
});
