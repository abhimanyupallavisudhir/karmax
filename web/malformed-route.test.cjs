const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const fn = (name) => { const start = src.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm')); assert.ok(start >= 0, name); return src.slice(start, src.indexOf('\n}', start) + 2); };
test('UI-25: malformed percent escapes do not break route parsing', () => {
  const ctx = vm.createContext({ URLSearchParams, location: { pathname: '/', search: '' } });
  if (src.includes('function decodeRoutePart(')) vm.runInContext(fn('decodeRoutePart'), ctx);
  vm.runInContext(fn('parseRoute'), ctx);
  assert.doesNotThrow(() => ctx.parseRoute('/bad%ZZ/project'));
});
