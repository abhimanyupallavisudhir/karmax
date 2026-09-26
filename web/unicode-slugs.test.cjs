const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const start = src.indexOf('function slugify(');
test('UI-15: Unicode names keep distinct stable route slugs', () => {
  const ctx = vm.createContext({}); vm.runInContext(src.slice(start, src.indexOf('\n}', start) + 2), ctx);
  assert.equal(ctx.slugify('日本語'), '日本語'); assert.equal(ctx.slugify('中文'), '中文');
  assert.equal(ctx.slugify('Cafe\u0301'), ctx.slugify('Café')); assert.equal(ctx.slugify('Hello World'), 'hello-world');
});
