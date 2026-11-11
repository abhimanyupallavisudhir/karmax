const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const fn = (name) => { const start = src.indexOf(`function ${name}(`); return src.slice(start, src.indexOf('\n}', start) + 2); };
const code = ['markTaskAsksRead', 'inboxState', 'readAsksOnScreen'].map(fn).join('\n');
test('UI-18: opening a task reads its asks, batched by organization, and restores a failed batch', async () => {
  const items = [{ id: 'a', organizationId: 'o', taskId: 't', unread: true }, { id: 'b', organizationId: 'o', taskId: 't', unread: true },
    { id: 'c', organizationId: 'failed', taskId: 't', unread: true }, { id: 'd', organizationId: 'o', taskId: 'other', unread: true }];
  const requests = [];
  let bells = 0;
  const after = [];
  const ctx = vm.createContext({ S: { inbox: items }, updateBell: () => { bells++; },
    refreshForMeCounts: () => after.push('counts'), refreshListQuietly: () => after.push('list'),
    api: async (url, options) => { requests.push([url, JSON.parse(options.body).ids]); if (url.includes('failed')) throw new Error('offline'); return []; } });
  vm.runInContext(code, ctx);
  ctx.markTaskAsksRead('t');
  assert.deepEqual(items.map((item) => item.unread), [false, false, false, true], 'read at once, the badge first');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(requests, [['/api/inbox?organizationId=o', ['a', 'b']], ['/api/inbox?organizationId=failed', ['c']]]);
  assert.deepEqual(items.map((item) => item.unread), [false, false, true, true], 'a failed batch is unread again');
  assert.equal(bells, 2);
  // A read mention has left For me: the sidebar counts and a list already back
  // on screen were read before the write landed (pramana#184).
  assert.deepEqual(after, ['counts', 'list'], 'the saved batch refreshes what counted it; the failed one does not');
  ctx.markTaskAsksRead('nothing');
  assert.equal(requests.length, 2, 'nothing to read, nothing sent');
});

test('an ask about the task on screen is read as it arrives, only in front of the person', () => {
  const read = [];
  const document = { hidden: false, hasFocus: () => true };
  const ctx = vm.createContext({ S: { selected: 't' }, document, markTaskAsksRead: (id) => read.push(id) });
  vm.runInContext(fn('readAsksOnScreen'), ctx);
  ctx.readAsksOnScreen();
  assert.deepEqual(read, ['t']);
  document.hidden = true; ctx.readAsksOnScreen();
  document.hidden = false; document.hasFocus = () => false; ctx.readAsksOnScreen();
  assert.deepEqual(read, ['t'], 'a background tab or an unfocused window has shown them nothing');
  document.hasFocus = () => true; ctx.S.selected = null; ctx.readAsksOnScreen();
  assert.deepEqual(read, ['t'], 'a list reads nothing');
  assert.match(src, /window\.addEventListener\('focus', readAsksOnScreen\)/, 'coming back to the window reads it');
});
