// Routine refreshes carry metadata; an explicit handoff must freeze fresh
// download/command identities without racing S.sessions or a task switch.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
function between(start, end) { return source.slice(source.indexOf(start), source.indexOf(end)); }

for (const local of [false, true]) test(`${local ? 'local' : 'hosted'} checkout uses the requested frozen export`, async () => {
  const calls = [], handoffs = [], listeners = {};
  const prepared = { do: { id: 'native', exportId: 'frozen', downloadUrl: '/bound/frozen' } };
  const element = { innerHTML: '', addEventListener(type, listener) { listeners[type] = listener; } };
  const host = { isConnected: true, innerHTML: '', querySelector: () => element, addEventListener() {},
    querySelectorAll: () => [], remove() { this.isConnected = false; } };
  const context = vm.createContext({
    S: { sessions: { do: { id: 'metadata-only' } }, projectId: 'project-1' },
    document: { createElement: () => host }, $: () => ({ appendChild() {}, addEventListener() {} }),
    hostLocal: () => local, siteNameMarkup: () => 'tavya', esc: String,
    taskRecord: () => ({ projectId: 'project-1', num: 3 }), projectById: () => ({ id: 'project-1', name: 'Site', organizationId: 'org-1' }),
    organizationById: () => ({ id: 'org-1', name: 'Acme' }), orgSlug: (org) => org.name.toLowerCase(), projectSlug: (project) => project.name.toLowerCase(),
    projectBase: () => '/acme/site', location: { origin: 'https://tavya.io' },
    localConversationHandoff: (...args) => { handoffs.push(args); return ''; },
    toast: message => { throw new Error(message); },
    api: async url => {
      calls.push(url);
      if (url.endsWith('/sessions')) return prepared;
      return { cwd: '/checkout', workspace: '/workspace', repositories: [], cloneScript: '', updateScript: '', pushScript: '' };
    },
  });
  vm.runInContext(between('async function localHandoffDialog(', 'async function openLocalCheckout('), context);
  vm.runInContext(local
    ? between('async function materializeLocalCheckout(', 'async function forkCloudSessionLocally(')
    : between('async function openLocalCheckout(', 'async function openProjectCheckout('), context);
  await vm.runInContext(`${local ? 'materializeLocalCheckout' : 'openLocalCheckout'}({ taskId: 'task-1', status: 'done' })`, context);
  if (!local) {
    // Hosted: the dialog is the CLI command; nothing is fetched until the Git-only fold opens.
    assert.match(host.innerHTML, /npx tavya clone acme\/site#3/);
    assert.equal(calls.length, 0);
    await listeners.toggle({ currentTarget: { open: true } });
  }
  assert.ok(calls.includes('/api/tasks/task-1/sessions'));
  assert.equal(handoffs.length, 1);
  assert.equal(handoffs[0][3], prepared);
  assert.equal(context.S.sessions.do.id, 'metadata-only');
});
