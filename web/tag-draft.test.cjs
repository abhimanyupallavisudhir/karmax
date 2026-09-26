const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
test('UI-24: tag catalogue redraws retain new-tag inputs', () => {
  const start = src.indexOf('function openTagsManager(');
  const body = src.slice(start, src.indexOf('\n}', start));
  assert.ok(body.includes("root.querySelectorAll('.tagm-new input, .tagm-new select, .tagm-new textarea')"));
  assert.ok(body.includes('control.value = saved.value'));
  assert.ok(body.includes('control.checked = saved.checked'));
});
