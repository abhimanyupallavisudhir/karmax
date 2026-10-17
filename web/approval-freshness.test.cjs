const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const fn = (name) => { const at = src.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm')); return src.slice(at, src.indexOf('\n}', at) + 2); };

// andhbhakt.com#1: the page had loaded the task's approvals for an earlier
// request; a later one reached it only as a `view.updated` (its own event was
// never published), and refreshTask kept the old list until a reload. The
// view's pending-decision count is the server's word on how many there are.
function page(server) {
  const reads = [];
  const ctx = vm.createContext({
    S: { selected: 't', projectId: 'p', tasks: [], taskOpenEpoch: 1, view: { taskId: 't', pendingDecisions: 1 },
      approvalRequests: [{ id: 'old', status: 'pending' }], permissionRequests: [], authorizationRequests: [], approvalItems: [], connections: [],
      taskApprovalsFor: 't', taskApprovalsCount: 1 },
    taskRecord: () => ({ projectId: 'p' }), projectById: () => ({ organizationId: 'o' }), pendingCancellationView: v => v,
    renderTaskPage: () => {}, scheduleTaskPageRender: () => {}, showDraftPage: () => {},
    api: (url) => { reads.push(url.replace(/\?.*/, '')); return Promise.resolve(server(url)); },
  });
  vm.runInContext(['refreshTask', 'isSeries', 'showsTaskApprovals', 'ensureTaskApprovals'].map(fn).join('\n'), ctx);
  return { ctx, reads };
}
const settle = async (ctx) => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };

test('a pending count the loaded approvals do not match reloads them', async () => {
  const requests = [{ id: 'old', status: 'pending' }, { id: 'new', status: 'pending', itemId: 'i' }];
  const { ctx, reads } = page((url) => url === '/api/tasks/t' ? { taskId: 't', pendingDecisions: 2, approvalRequests: 2 }
    : url.startsWith('/api/vault/requests') ? requests : url.startsWith('/api/vault/items') ? [{ id: 'i' }] : []);
  await ctx.refreshTask('view.updated');
  await settle(ctx);
  assert.deepEqual(ctx.S.approvalRequests.map(r => r.id), ['old', 'new']);
  assert.deepEqual(ctx.S.approvalItems.map(i => i.id), ['i']);
  assert.equal(ctx.S.taskApprovalsCount, 2);
  // Agreed now: the next lifecycle refresh reads the view alone.
  reads.length = 0;
  await ctx.refreshTask('view.updated');
  await settle(ctx);
  assert.deepEqual(reads.filter(url => /requests|connections|vault/.test(url)), []);
});

test('a decision resolved elsewhere drops from the conversation by the same count', async () => {
  const { ctx } = page((url) => url === '/api/tasks/t' ? { taskId: 't' } : []);
  await ctx.refreshTask('view.updated');
  await settle(ctx);
  assert.deepEqual(ctx.S.approvalRequests, []);
  assert.equal(ctx.S.taskApprovalsCount, 0);
});

test('an approval event reloads every kind even when the count is unchanged', async () => {
  // One request resolved and another raised between two reads: same count, new rows.
  const { ctx, reads } = page((url) => url === '/api/tasks/t' ? { taskId: 't', pendingDecisions: 1 }
    : url.startsWith('/api/permission-requests') ? [{ id: 'perm', status: 'pending' }] : []);
  await ctx.refreshTask('permission.approval-requested');
  await settle(ctx);
  assert.deepEqual(ctx.S.permissionRequests.map(r => r.id), ['perm']);
  assert.deepEqual(ctx.S.approvalRequests, []);
  for (const route of ['/api/vault/requests', '/api/permission-requests', '/api/authorization-requests', '/api/connections'])
    assert.ok(reads.includes(route), `${route} in ${reads.join(', ')}`);
});

test('a slower superseded reload never overwrites a newer one', async () => {
  const releases = [];
  const { ctx } = page((url) => url.startsWith('/api/vault/requests') ? new Promise(r => releases.push(r)) : []);
  const first = ctx.ensureTaskApprovals('t', { force: true });
  const second = ctx.ensureTaskApprovals('t', { force: true });
  releases[1]([{ id: 'newer', status: 'pending' }]);
  await second;
  releases[0]([{ id: 'older', status: 'pending' }]);
  await first;
  assert.deepEqual(ctx.S.approvalRequests.map(r => r.id), ['newer']);
});
