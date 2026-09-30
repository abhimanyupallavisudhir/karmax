const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
function fn(name) {
  const start = src.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, name);
  const end = src.indexOf('\n}', start);
  return src.slice(start, end + 2);
}
test('UI-1: stored tag kinds cannot escape class attributes', () => {
  const ctx = vm.createContext({ tagById: () => ({ kind: 'flag" onclick="alert(1)' }), tagPathStr: () => '<tag>' });
  vm.runInContext(src.slice(src.indexOf('const esc ='), src.indexOf('\n\n', src.indexOf('const esc ='))) + '\n' + fn('tagChips'), ctx);
  assert.match(ctx.tagChips({ tags: ['tag'] }), /flag&quot; onclick=&quot;/);
  assert.doesNotMatch(src, /\$\{(?:tag|t)\.kind \|\| ''\}/);
});
test('UI-2/UI-26: review and PR links use the scheme allowlist', () => {
  for (const expression of ['pr.url', 'c.pr.url', 'l.url', 'ref.pr']) {
    assert.ok(!src.includes('href="${esc(' + expression + ')}"'), expression);
  }
  const ctx = vm.createContext({}); vm.runInContext(fn('safeHref'), ctx);
  for (const url of ['javascript:alert(1)', 'data:text/html,hello', 'java\nscript:alert(1)']) assert.equal(ctx.safeHref(url), '#');
  assert.equal(ctx.safeHref('https://github.com/a/b/pull/1'), 'https://github.com/a/b/pull/1');
});
