// Picker interaction regressions, including deferred network responses.
// Run: node web/agent-picker.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const pickerSource = src.slice(src.indexOf('function openTaskPicker('), src.indexOf('// Project tag catalogue manager'));
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function harness({ tasks, groups, attempts, agents, failure, mode = 'agent' }) {
  class Element {
    constructor(dataset = {}) { this.dataset = dataset; this.listeners = {}; this.html = ''; this.history = []; this.classList = { toggle() {} }; }
    set innerHTML(html) {
      this.html = html; this.history.push(html);
      this.rows = [...html.matchAll(/<(?:div|button)[^>]*data-nav[^>]*>/g)].map(([tag]) => new Element(
        Object.fromEntries([...tag.matchAll(/data-([\w-]+)="([^"]*)"/g)].map(([, k, v]) => [k, v]))));
    }
    get innerHTML() { return this.html; }
    querySelectorAll(selector) { return selector === '.pick-row' || selector === '[data-nav]' ? this.rows || [] : []; }
    addEventListener(type, handler) { this.listeners[type] = handler; }
    setAttribute() {} removeAttribute() {} scrollIntoView() {} focus() {}
    remove() { this.removed = true; }
  }
  const nodes = Object.fromEntries(['modal-root', 'pk-search', 'pk-list', 'pk-views', 'pk-toolbar', 'pk-scrim', 'pk-close'].map(id => [id, new Element()]));
  let host;
  nodes['modal-root'].appendChild = el => { host = el; };
  const picks = [], errors = [], calls = [];
  const context = vm.createContext({
    document: { createElement: () => new Element() },
    $: selector => nodes[selector.slice(1)],
    S: { projectId: 'project', views: [] }, ALL_VIEW: 'all', BUILTIN_VIEWS: [],
    esc: v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    viewIdForQuery: () => 'all', queryToolbarHtml: () => '', wireQueryToolbar() {},
    effectiveQuery: q => q, stageLabel: () => 'Done', workflowLabel: () => 'Software',
    priorityFlag: () => '', tagChips: () => '', agentRoleLabel: role => role,
    setTimeout, clearTimeout, toast: message => errors.push(message),
    api: async url => {
      calls.push(url);
      if (failure?.(url)) throw new Error('Offline');
      if (url.includes('/search?')) return { tasks, groups };
      const [, id, endpoint] = url.match(/\/tasks\/([^/]+)\/(attempts|sessions)/);
      if (endpoint === 'attempts') return { attempts: await attempts[id] };
      return await agents[id];
    },
  });
  vm.runInContext(pickerSource, context);
  context.openTaskPicker({ mode, onPick: pick => picks.push(pick) });
  return { nodes, picks, errors, calls, host: () => host,
    click: (index = 0) => nodes['pk-list'].rows[index].listeners.click(),
    key: key => nodes['pk-search'].listeners.keydown({ key, preventDefault() {}, stopPropagation() {} }),
  };
}
const task = (id, n = 1, extra = {}) => ({ id, title: id, attemptNumber: n, params: {}, ...extra });
const session = id => ({ do: { id, provider: 'codex' } });

test('one agent selects without ever opening a menu, including during a delayed fetch', async () => {
  const a = task('a'), wait = deferred();
  const h = harness({ tasks: [a], attempts: { a: [a] }, agents: { a: wait.promise } });
  await tick(); const selection = h.click(); await tick();
  assert.equal(h.picks.length, 0);
  assert.ok(h.nodes['pk-list'].history.every(html => !html.includes('pk-sessions')));
  wait.resolve(session('one')); await selection;
  assert.equal(h.picks[0].task.id, 'a'); assert.equal(h.picks[0].session.id, 'one');
  assert.ok(h.host().removed);
  assert.ok(h.nodes['pk-list'].history.every(html => !html.includes('pk-sessions')));
});

test('attempts have separate rows with compact agents and preserve exact sub-task source', async () => {
  const a = task('child-a', 1, { parentTaskId: 'parent' });
  const b = task('child-b', 2, { parentTaskId: 'parent', params: { _authorization: { level: 'maintainer' } } });
  const h = harness({ tasks: [], groups: [{ label: 'Sub-tasks', tasks: [b] }], attempts: { 'child-b': [a, b] },
    agents: { 'child-a': session('first'), 'child-b': { ...session('second'), review: { id: 'review', provider: 'claude' } } } });
  await tick(); await h.click();
  const html = h.nodes['pk-list'].innerHTML;
  assert.equal((html.match(/class="pk-attempt"/g) || []).length, 2);
  assert.equal((html.match(/class="pick-row pk-agent"/g) || []).length, 3);
  assert.ok(html.includes('Attempt 1') && html.includes('Attempt 2'));
  await h.click(3);
  assert.equal(h.picks[0].task, b); assert.equal(h.picks[0].role, 'review');
  assert.equal(h.picks[0].session.id, 'review');
  assert.ok(h.calls.every(url => !url.includes('/tasks/parent/')));
});

test('multiple attempts remain visible even when only one has an agent', async () => {
  const a = task('a'), b = task('b', 2);
  const h = harness({ tasks: [b], attempts: { b: [a, b] }, agents: { a: session('one'), b: {} } });
  await tick(); await h.click();
  assert.equal(h.picks.length, 0);
  assert.ok(h.nodes['pk-list'].innerHTML.includes('No agent to fork yet. Choose another attempt or task.'));
  await h.click(1); assert.equal(h.picks[0].task.id, 'a');
});

test('multiple roles in one attempt can be selected with arrow keys and Enter', async () => {
  const a = task('a');
  const h = harness({ tasks: [a], attempts: { a: [a] }, agents: { a: { ...session('one'), merge: { id: 'merge' } } } });
  await tick(); await h.click();
  h.key('ArrowDown'); h.key('ArrowDown'); h.key('Enter');
  assert.equal(h.picks[0].role, 'merge');
});

test('close, search, or another task invalidate a pending selection; repeated clicks share requests', async () => {
  for (const action of ['close', 'search', 'other', 'repeat']) {
    const a = task('a'), b = task('b'), wait = deferred();
    const h = harness({ tasks: [a, b], attempts: { a: [a], b: [b] }, agents: { a: wait.promise, b: session('b') } });
    await tick(); const selection = h.click(); await tick();
    let second;
    if (action === 'close') h.key('Escape');
    if (action === 'search') { h.nodes['pk-search'].value = 'new'; h.nodes['pk-search'].listeners.input(); }
    if (action === 'other') await h.click(1);
    if (action === 'repeat') second = h.click();
    wait.resolve(session('a')); await selection; await second;
    assert.equal(h.picks.length, ['other', 'repeat'].includes(action) ? 1 : 0, action);
    if (action === 'other') assert.equal(h.picks[0].task.id, 'b');
    assert.equal(h.calls.filter(url => url === '/api/tasks/a/attempts').length, 1);
  }
});

test('failed lookup is retryable and does not masquerade as an empty attempt', async () => {
  const a = task('a'); let offline = true;
  const h = harness({ tasks: [a], attempts: { a: [a] }, agents: { a: session('a') }, failure: url => offline && url.endsWith('/sessions') });
  await tick(); await h.click();
  assert.equal(h.errors.length, 1); assert.equal(h.picks.length, 0);
  assert.ok(!h.nodes['pk-list'].innerHTML.includes('pk-sessions'));
  offline = false; await h.click(); assert.equal(h.picks.length, 1);
});

test('ordinary task picking does not load agents', async () => {
  const a = task('a');
  const h = harness({ tasks: [a], mode: 'task' });
  await tick(); await h.click();
  assert.equal(h.picks[0], a); assert.equal(h.calls.length, 1);
});


test('Escape also closes the picker while an agent button has focus', async () => {
  const a = task('a');
  const h = harness({ tasks: [a], attempts: { a: [a] }, agents: { a: { ...session('one'), merge: { id: 'merge' } } } });
  await tick(); await h.click();
  h.host().listeners.keydown({ key: 'Escape', stopPropagation() {} });
  assert.ok(h.host().removed); assert.equal(h.picks.length, 0);
});
