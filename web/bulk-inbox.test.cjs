const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const start = src.indexOf('async function markVisibleInboxRead(');
const code = src.slice(start, src.indexOf('\n}', start) + 2);
test('UI-18: mark all read batches by organization and preserves failed rows', async () => {
  const items = [{ id: 'a', organizationId: 'o', unread: true }, { id: 'b', organizationId: 'o', unread: true }, { id: 'c', organizationId: 'failed', unread: true }];
  const requests = [];
  const ctx = vm.createContext({ S: { inbox: items }, inboxItems: () => items, updateBell: () => {}, renderMain: () => {}, renderRail: () => {},
    api: async (url, options) => { requests.push(url); if (url.includes('failed')) throw new Error('offline'); return JSON.parse(options.body).ids.map(id => ({ id, unread: false })); } });
  vm.runInContext(code, ctx);
  await assert.rejects(ctx.markVisibleInboxRead());
  assert.equal(requests.length, 2);
  assert.deepEqual(items.map(item => item.unread), [false, false, true]);
});
