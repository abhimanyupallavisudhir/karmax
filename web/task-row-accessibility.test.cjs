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
test('UI-35: focusable queue rows name the task and its place in the queue', () => {
  const rows = src.split('\n').filter(line => line.includes('class="queue-item') && line.includes('tabindex="0"'));
  assert.equal(rows.length, 3, 'merge queue, provider landing and agent queue rows');
  for (const row of rows) {
    assert.ok(row.includes('role="group"'), row);
    assert.ok(row.includes('aria-label="${esc(queueRowLabel('), row);
  }
  const start = src.indexOf('function queueRowLabel(');
  const label = new Function(`${src.slice(start, src.indexOf('\n}', start) + 2)} return queueRowLabel;`)();
  assert.equal(label({ num: 12, title: 'Fix <b>' }, 'queued', 2), '#12 Fix <b> · queued · position 2');
  assert.equal(label({ title: 'Run' }, 'merging'), 'Run · merging');
});
