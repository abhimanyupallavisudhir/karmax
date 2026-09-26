const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
test('UI-16: both GitHub disconnect controls confirm their effect', () => {
  const handlers = [...src.matchAll(/row\.querySelector\('\.github-remove'\)\?\.addEventListener\('click', async \(\) => \{([\s\S]*?)await api/g)];
  assert.equal(handlers.length, 2);
  for (const [, beforeWrite] of handlers) assert.match(beforeWrite, /if \(!confirm\(/);
});
