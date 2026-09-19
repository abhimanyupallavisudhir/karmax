// Routine refreshes carry metadata; an explicit handoff must freeze fresh
// download/command identities without racing S.sessions or a task switch.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
function between(start, end) { return source.slice(source.indexOf(start), source.indexOf(end)); }

for (const local of [false, true]) test(`${local ? 'local' : 'hosted'} checkout uses the requested frozen export`, async () => {
  const calls = [], handoffs = [];
  const prepared = { do: { id: 'native', exportId: 'frozen', downloadUrl: '/bound/frozen' } };
  const button = { addEventListener() {} };
  const host = { isConnected: true, innerHTML: '', querySelector: () => button,
    querySelectorAll: () => [], remove() { this.isConnected = false; } };
  const context = vm.createContext({
    S: { sessions: { do: { id: 'metadata-only' } } },
    document: { createElement: () => host }, $: () => ({ appendChild() {}, addEventListener() {} }),
    hostLocal: () => false, siteNameMarkup: () => 'tavya', esc: String,
    localConversationHandoff: (...args) => { handoffs.push(args); return ''; },
    toast: message => { throw new Error(message); },
    api: async url => {
      calls.push(url);
      if (url.endsWith('/sessions')) return prepared;
      return { cwd: '/checkout', workspace: '/workspace', repositories: [], cloneScript: '', updateScript: '', pushScript: '' };
    },
  });
  vm.runInContext(local
    ? between('async function materializeLocalCheckout(', 'async function forkCloudSessionLocally(')
    : between('async function openLocalCheckout(', 'async function openProjectCheckout('), context);
  await vm.runInContext(`${local ? 'materializeLocalCheckout' : 'openLocalCheckout'}({ taskId: 'task-1', status: 'done' })`, context);
  assert.ok(calls.includes('/api/tasks/task-1/sessions'));
  assert.equal(handoffs.length, 1);
  assert.equal(handoffs[0][3], prepared);
  assert.equal(context.S.sessions.do.id, 'metadata-only');
});
