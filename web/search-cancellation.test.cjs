const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const start = src.indexOf('function openGlobalSearch(');
const body = src.slice(start, src.indexOf('\n}', start) + 2);
test('RQ-14/UI-18: superseded and closed searches abort network requests', () => {
  assert.ok(/const close = .*controller\?\.abort\(\)/.test(body));
  assert.ok(body.includes('signal: controller.signal'));
  assert.ok(body.includes('q.length < 2'));
  assert.ok(body.includes('/api/search?q='));
  assert.ok(!body.includes('S.projects.map(async'));
});
