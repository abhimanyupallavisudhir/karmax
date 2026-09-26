const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
test('UI-35: focusable task rows have a role and escaped accessible name', () => {
  const rows = src.split('\n').filter(line => line.includes('class="task-row') && line.includes('tabindex="0"'));
  assert.ok(rows.length >= 3);
  for (const row of rows) {
    assert.ok(row.includes('role="group"'), row);
    assert.ok(row.includes('aria-label="${esc('), row);
  }
});
