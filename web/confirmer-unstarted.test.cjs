// Who reviews a task can be changed in its form until it has started: a draft,
// a task waiting for its trigger, or a series (only its runs work, each with
// its own copy of the route). Once any attempt runs, the shared route is
// changed on the running attempt's page instead (#976).
// Run: node web/confirmer-unstarted.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const start = src.indexOf('function taskUnstarted(');
assert.ok(start >= 0, 'taskUnstarted is defined');
const end = src.indexOf('\n}\n', start);
eval(src.slice(start, end + 2));

assert.equal(taskUnstarted({ draft: true }), true);
assert.equal(taskUnstarted({ repeatable: true, triggerState: 'armed' }), true); // a series
assert.equal(taskUnstarted({ triggerState: 'armed' }), true); // waiting for its trigger
assert.equal(taskUnstarted({ triggerState: 'fired' }), false);
assert.equal(taskUnstarted({}), false); // queued or running
assert.equal(taskUnstarted(undefined), false);
assert.match(src, /confirmerFrozen = !!draft\?\.id\s*&& !!formAttemptGroup\?\.attempts\?\.some\(\(a\) => !taskUnstarted\(a\.params\)\)/);
console.log('confirmer of an unstarted task: ok');
