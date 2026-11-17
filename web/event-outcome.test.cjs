// What one project event did, as Settings → Events says it: a started run says
// why its gate let it start (on hover, as a skip says why it did not).
// Run: node web/event-outcome.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
function extractFn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  const open = src.indexOf(') {', start) + 2;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

global.esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
global.taskUrl = (id) => `/org/project/tasks/${id}`;
eval(extractFn('eventOutcome'));

const started = eventOutcome({ claims: [{ state: 'started', runId: 'task_1', gateReason: 'a defect in "openPr", not the customer\'s' }] });
assert.match(started, /^<span title="its gate: a defect in &quot;openPr&quot;, not the customer's">Started <a /);
assert.match(started, /href="\/org\/project\/tasks\/task_1">a run<\/a><\/span>$/);
assert.equal(eventOutcome({ claims: [{ state: 'started', runId: 'task_2' }] }),
  'Started <a data-pe-task="task_2" data-spa href="/org/project/tasks/task_2">a run</a>');
assert.match(eventOutcome({ claims: [{ state: 'skipped', reason: 'its gate: the customer\'s own repository' }] }), /Skipped: its gate: the customer's own repository/);
console.log('event outcome: ok');
