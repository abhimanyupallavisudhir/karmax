const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
test('UI-28: a deleted selected task leaves no stale view', async () => {
  const start = src.indexOf('async function refreshTask(');
  const code = src.slice(start, src.indexOf('\n}', start) + 2);
  let closed = false;
  const ctx = vm.createContext({ S: { selected: 'gone', projectId: 'p', tasks: [{ id: 'gone' }] },
    taskRecord: () => ({}), projectById: () => ({}), api: async () => { throw Object.assign(new Error('missing'), { status: 404 }); },
    closeTask: () => { closed = true; }, toast: () => {}, renderTaskPage: () => {} });
  vm.runInContext(code, ctx); await ctx.refreshTask('view.updated');
  assert.equal(closed, true);
  assert.equal(ctx.S.tasks.length, 0);
});
