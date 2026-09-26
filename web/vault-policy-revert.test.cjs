const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
test('UI-23: rejected vault policy saves restore persisted selections', () => {
  const start = src.indexOf('const savePolicy = async () =>');
  const body = src.slice(start, src.indexOf("row.querySelector('.vi-pol-use').addEventListener",start));
  assert.ok(body.includes("row.querySelector('.vi-pol-use').value = item.policy?.use"));
  assert.ok(body.includes("row.querySelector('.vi-pol-reveal').value = item.policy?.reveal"));
});
