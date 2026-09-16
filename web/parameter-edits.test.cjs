// Exercise the actual control handlers, including changes made during a save.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const fn = (name) => {
  const match = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n}`));
  assert.ok(match, name);
  return match[0];
};
class Element {
  constructor() {
    this.listeners = {}; this.dataset = {}; this.value = ''; this.isConnected = true;
    this.classList = { toggle() {} };
  }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  async fire(type, event = {}) { for (const handler of this.listeners[type] || []) await handler(event); }
  dispatchEvent(event) { this.fire(event.type, event); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}
const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
async function main() {
  // Choosing a preset with the mouse must notify the containing form too.
  const input = new Element(), menu = new Element(), caret = new Element();
  const combo = { querySelector: (selector) => ({ input, '.combo-menu': menu, '.combo-caret': caret })[selector] };
  let changes = 0;
  input.addEventListener('change', (event) => { assert.equal(event.bubbles, true); changes++; });
  const comboContext = vm.createContext({ Event, normalizeComboOption: (x) => x });
  vm.runInContext(fn('wireCombo'), comboContext);
  comboContext.wireCombo(combo, () => [], () => {});
  await menu.fire('mousedown', { preventDefault() {}, target: { closest: () => ({ dataset: { v: 'new-model' } }) } });
  assert.equal(input.value, 'new-model'); assert.equal(changes, 1);

  const state = { paramEditDrafts: {}, avatars: [] };
  const record = { params: {} };
  let elements, complete, requests = [];
  const context = vm.createContext({
    S: state, CSS: { escape: (x) => x }, sameJson, Object, structuredClone,
    document: { getElementById: (id) => elements[id] || null },
    wireAgentFields() {}, taskRecord: () => record,
    schemaFor: () => [{ name: 'target', label: 'Target', type: 'string', scopes: ['task'] }],
    api: (_path, options) => { requests.push(JSON.parse(options.body)); return new Promise((resolve) => { complete = resolve; }); },
    toast() {}, setTimeout() {}, refreshTask() {}, refreshTasks() {},
  });
  vm.runInContext(['collectParamEdits', 'paramDirtyNames', 'setParamSaveState', 'wireParams', 'readMcpPicker', 'readAgentSpec'].map(fn).join('\n'), context);
  const render = (value) => {
    const root = new Element(), button = new Element(), field = new Element(), bar = new Element();
    field.value = value;
    root.querySelector = (selector) => selector.startsWith('[data-field=') ? field : null;
    button.closest = () => bar;
    elements = { 'tp-params': root, 'params-save': button, 'params-save-status': { lastElementChild: {} } };
    context.wireParams({ taskId: 'task', workflow: 'test', editableParams: ['target'] });
    return { root, button, field };
  };
  let form = render('main');
  assert.equal(form.button.disabled, true);
  form.field.value = 'release'; await form.root.fire('input');
  assert.equal(form.button.disabled, false);
  const pending = form.button.fire('click');
  assert.equal(form.root.dataset.saveState, 'saving');
  form = render('release'); // WebSocket repaint while the request is pending
  assert.equal(form.button.disabled, true);
  form.field.value = 'next'; await form.root.fire('input');
  complete({}); await pending;
  assert.equal(form.root.dataset.saveState, 'dirty');
  assert.equal(state.paramEditDrafts.task.values.target, 'next');
  assert.equal(state.paramEditDrafts.task.saved.target, 'release');
  const second = form.button.fire('click'); complete({}); await second;
  assert.equal(form.root.dataset.saveState, 'saved');
  assert.equal(state.paramEditDrafts.task, undefined);
  assert.equal(record.params.target, 'next');
  assert.deepEqual(requests, [{ params: { target: 'release' } }, { params: { target: 'next' } }]);
  form.field.value = ''; await form.root.fire('input'); await form.button.fire('click');
  assert.equal(requests.length, 2, 'blank scalar must not silently save an empty patch');
  assert.equal(form.root.dataset.saveState, 'dirty');

  // Two Avatars with the same runtime are still distinct parameter values.
  context.readResume = () => undefined;
  state.avatars = [{ id: 'one', runtime: { provider: 'codex', model: 'same' } }, { id: 'two', runtime: { provider: 'codex', model: 'same' } }];
  const avatar = { value: 'one' };
  const agent = { querySelector: (selector) => ({ '.af-avatar': avatar, '.af-effort': { value: '' } })[selector] };
  const root = { querySelector: () => agent };
  const fields = [{ name: 'agent:do', role: 'do', type: 'agent' }];
  const before = context.collectParamEdits(root, fields);
  avatar.value = 'two';
  const after = context.collectParamEdits(root, fields);
  assert.equal(after['agent:do'].avatarId, 'two');
  assert.equal(context.paramDirtyNames(before, after, fields).length, 1);
  const controls = { flag: { checked: false }, limit: { value: '2' }, lines: { value: 'one\ntwo' }, mode: { value: 'first' } };
  const plainFields = [{ name: 'flag', type: 'boolean' }, { name: 'limit', type: 'number' }, { name: 'lines', type: 'list' }, { name: 'mode', type: 'select' }];
  const plainRoot = { querySelector: (selector) => controls[selector.match(/"(.*?)"/)[1]] };
  const plainBefore = context.collectParamEdits(plainRoot, plainFields);
  controls.flag.checked = true; controls.limit.value = '3'; controls.lines.value = 'three'; controls.mode.value = 'second';
  assert.equal(context.paramDirtyNames(plainBefore, context.collectParamEdits(plainRoot, plainFields), plainFields).length, 4);

  // Authorization has its own save boundary, including modal vault edits.
  const authState = { projects: [{ id: 'project', organizationId: 'org' }] };
  const authRecord = { projectId: 'project', params: { _authorization: {} } };
  let authElements, authChanged, pickVault, authComplete;
  const authRequests = [];
  const authContext = vm.createContext({
    S: authState, sameJson, structuredClone, document: { getElementById: (id) => authElements[id] },
    taskRecord: () => authRecord,
    wireAuthorizationEditor: (_select, _projects, changed) => { authChanged = changed; },
    readAuthorizationEditor: (select) => structuredClone(select.selection),
    wireResumeReauthorization() {}, toast() {}, setTimeout() {}, refreshTasks() {},
    openVaultGrantPicker: (_items, _ids, _policies, callback) => { pickVault = callback; },
    api: (path, options) => {
      if (path.startsWith('/api/vault/items')) return Promise.resolve([{ id: 'credential' }]);
      authRequests.push(JSON.parse(options.body));
      return new Promise((resolve) => { authComplete = resolve; });
    },
  });
  vm.runInContext(fn('wireTaskAuthorization'), authContext);
  const renderAuth = async (selection) => {
    const select = new Element(), button = new Element(), vault = new Element(), status = new Element(), bar = new Element();
    select.selection = selection; select.closest = () => null; button.closest = () => bar;
    authElements = { 'tp-authorization': select, 'tp-auth-save': button, 'tp-vault-open': vault, 'tp-vault-count': new Element(), 'tp-auth-status': status };
    await authContext.wireTaskAuthorization({ taskId: 'task' });
    return { select, button, vault, status, bar };
  };
  const selection = { level: 'developer', scope: 'projects', projectIds: ['project'] };
  let auth = await renderAuth(selection);
  assert.equal(auth.button.disabled, true);
  auth.select.selection = { ...selection, scope: 'organization' }; authChanged();
  assert.equal(auth.status.textContent, 'Unsaved authorization changes');
  auth.select.selection = selection; authChanged();
  assert.equal(auth.button.disabled, true, 'reverting authorization clears the indicator');
  await auth.vault.fire('click'); pickVault(['credential'], { credential: { reveal: 'deny' } });
  assert.equal(auth.button.disabled, false, 'vault modal changes enable authorization save');
  const authPending = auth.button.fire('click');
  auth = await renderAuth(selection);
  assert.equal(auth.button.disabled, true, 'saving state survives a repaint');
  auth.select.selection = { ...selection, level: 'administrator' }; authChanged();
  authComplete({}); await authPending;
  assert.equal(auth.status.textContent, 'Unsaved authorization changes');
  assert.equal(authState.authorizationEdits.task.values.authorization.level, 'administrator');
  assert.deepEqual(authRequests[0].credentialGrants, ['use-credential:item:credential']);
  assert.deepEqual(authRequests[0].credentialPolicies, { credential: { reveal: 'deny' } });
  console.log('Parameter edit interaction regressions passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
