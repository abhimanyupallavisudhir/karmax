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
  const views = () => reads.filter(url => url === '/api/tasks/t');
  assert.deepEqual(views(), ['/api/tasks/t']);
  releases.shift()({ taskId: 't' });
  for (let i = 0; i < 10 && !releases.length; i++) await new Promise(r => setImmediate(r));
  assert.deepEqual(views(), ['/api/tasks/t', '/api/tasks/t']);
  releases.shift()({ taskId: 't', title: 'latest' }); await Promise.all(calls);
  assert.equal(ctx.S.view.title, 'latest');
});
test('a lifecycle refresh re-resolves the widgets bound to the view', async () => {
  // The Overview's Progress section (stage, changed files) is resolved from the
  // view server-side; a stage change arrives only as `view.updated`.
  const reads = [];
  const ctx = vm.createContext({ S: { selected: 't', projectId: 'p', tasks: [] },
    taskRecord: () => ({}), projectById: () => ({}), pendingCancellationView: v => v, renderTaskPage: () => {},
    api: url => { reads.push(url); return Promise.resolve(url === '/api/tasks/t' ? { taskId: 't', stage: 'review' } : [{ widgets: [] }]); } });
  vm.runInContext(fn, ctx);
  await ctx.refreshTask('view.updated');
  assert.ok(reads.includes('/api/tasks/t/widgets'), reads.join(', '));
  reads.length = 0;
  await ctx.refreshTask('session.started');
  assert.deepEqual(reads.filter(url => url.endsWith('/widgets')), []);
});
