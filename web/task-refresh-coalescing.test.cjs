const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const start = src.indexOf('async function refreshTask(');
const fn = src.slice(start, src.indexOf('\n}', start) + 2);
test('RQ-2/UI-6: lifecycle bursts share a read and retain one trailing refresh', async () => {
  const reads = [], releases = [];
  const ctx = vm.createContext({ S: { selected: 't', projectId: 'p', tasks: [] },
    taskRecord: () => ({}), projectById: () => ({}), pendingCancellationView: v => v, renderTaskPage: () => {},
    api: url => { reads.push(url); return url === '/api/tasks/t' ? new Promise(r => releases.push(r)) : Promise.resolve([]); } });
  vm.runInContext(fn, ctx);
  const calls = Array.from({ length: 20 }, () => ctx.refreshTask('view.updated'));
  assert.deepEqual(reads, ['/api/tasks/t']);
  releases.shift()({ taskId: 't' });
  for (let i = 0; i < 10 && !releases.length; i++) await new Promise(r => setImmediate(r));
  assert.deepEqual(reads, ['/api/tasks/t', '/api/tasks/t']);
  releases.shift()({ taskId: 't', title: 'latest' }); await Promise.all(calls);
  assert.equal(ctx.S.view.title, 'latest');
});
