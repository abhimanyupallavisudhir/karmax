const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const start = src.indexOf('function markTaskAsksRead(');
const code = src.slice(start, src.indexOf('\n}', start) + 2);
test('UI-18: opening a task reads its asks, batched by organization, and restores a failed batch', async () => {
  const items = [{ id: 'a', organizationId: 'o', taskId: 't', unread: true }, { id: 'b', organizationId: 'o', taskId: 't', unread: true },
    { id: 'c', organizationId: 'failed', taskId: 't', unread: true }, { id: 'd', organizationId: 'o', taskId: 'other', unread: true }];
  const requests = [];
  let bells = 0;
  const ctx = vm.createContext({ S: { inbox: items }, updateBell: () => { bells++; },
    api: async (url, options) => { requests.push([url, JSON.parse(options.body).ids]); if (url.includes('failed')) throw new Error('offline'); return []; } });
  vm.runInContext(code, ctx);
  ctx.markTaskAsksRead('t');
  assert.deepEqual(items.map((item) => item.unread), [false, false, false, true], 'read at once, the badge first');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(requests, [['/api/inbox?organizationId=o', ['a', 'b']], ['/api/inbox?organizationId=failed', ['c']]]);
  assert.deepEqual(items.map((item) => item.unread), [false, false, true, true], 'a failed batch is unread again');
  assert.equal(bells, 2);
  ctx.markTaskAsksRead('nothing');
  assert.equal(requests.length, 2, 'nothing to read, nothing sent');
});
