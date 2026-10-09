// Regression coverage for the expanded Agent field's previous-task fork UI.
// Run: node web/agent-fork.test.cjs
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

function extractFn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0;
  const open = src.indexOf('{', start);
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

global.esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
global.inhAttr = (v) => `data-inherit='${esc(JSON.stringify(v ?? null))}'`;
global.wireMcpPicker = () => {};
global.modelFieldHtml = (cls, spec) => `<input class="${cls}" value="${esc([spec.provider, spec.model, spec.effort].filter(Boolean).join(':'))}">`;
global.AGENT_PROVIDERS = ['claude', 'codex', 'opencode', 'mock'];
global.agentProviderChoice = (provider) => AGENT_PROVIDERS.includes(provider) ? provider : AGENT_PROVIDERS[0];
global.S = { tasks: [], meta: { hostLocal: true }, projects: [{ id: 'p1', name: 'Website' }, { id: 'p2', name: 'Billing' }] };
global.document = { querySelectorAll: () => [] };
global.hostLocal = () => S.meta?.hostLocal !== false;
eval(extractFn('siteName'));
eval(extractFn('siteNameMarkup'));
global.projectById = (id) => S.projects.find((p) => p.id === id);
global.taskUrl = (id, rec) => `/acme/${rec?.projectId || 'p1'}/tasks/${rec?.num ?? id}`;
if (typeof global.CustomEvent !== 'function') {
  global.CustomEvent = class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; this.bubbles = !!init.bubbles; } };
}
eval(extractFn('authorizationLevels'));
eval(extractFn('normalizedAuthorization'));
eval(extractFn('authorizationSummary'));
eval(extractFn('previousTaskGrants'));
eval(extractFn('previousGrantsSummary'));
eval(extractFn('wireResumeReauthorization'));
eval(extractFn('agentRoleLabel'));
eval(extractFn('resumeChosenInner'));
eval(extractFn('resumeUploadInner'));
eval(extractFn('mcpPickerHtml'));
eval(extractFn('renderAgentField'));
eval(extractFn('agentBlockHtml'));
eval(extractFn('agentInstructions'));
eval(extractFn('agentAuthorityHtml'));
eval(extractFn('forkBranchDefaults'));
eval(extractFn('prefillForkBranch'));
eval(extractFn('retargetForkBase'));
eval(extractFn('selectedDepIds'));
eval(extractFn('showForkWorldHelp'));
eval(extractFn('collectForm'));
eval(extractFn('readResume'));
eval(extractFn('readAuthorizationEditor'));

let pass = 0;
let fail = 0;
const ok = (condition, message) => condition ? pass++ : (fail++, console.error('FAIL:', message));

ok(forkBranchDefaults({ lastView: { status: 'cancelled', branch: 'tavya/source', targetBranch: 'main' } }).base === 'tavya/source', 'cancelled forks default to the source branch');
ok(forkBranchDefaults({ status: 'done', branch: 'tavya/source', targetBranch: 'release' }).base === 'release', 'landed forks default to their merge destination');
ok(!forkBranchDefaults({}).base, 'a conversation without a branch keeps ordinary defaults');
global.CSS = { escape: (value) => value };
global.sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const baseInput = { value: 'main', getAttribute: () => '"main"' };
const branchForm = { querySelector: (selector) => selector === '[data-field="base"]' ? baseInput : {} };
ok(collectForm(branchForm, [{ name: 'base', type: 'branch' }]).base === 'main', 'changing a fork to the inherited base remains an explicit branch choice');
baseInput.value = '';
ok(collectForm(branchForm, [{ name: 'base', type: 'branch' }]).base === 'main', 'clearing a fork base uses the inherited branch without reselecting the source branch');
let branchChanges = 0;
const forkBranchInput = { value: 'main', dispatchEvent: () => branchChanges++ };
const forkForm = { querySelector: (selector) => selector === '[data-field="base"]' ? forkBranchInput : {} };
prefillForkBranch({ dataset: { agent: 'do' }, closest: () => forkForm }, { lastView: { status: 'waiting', branch: 'tavya/source' } });
ok(forkBranchInput.value === 'tavya/source' && branchChanges === 1, 'picking a source fills the branch field and announces the change');
global.document.querySelectorAll = (selector) => selector === '#dep-chips [data-depid]' ? [{ dataset: { depid: 'task_source' } }] : [];
forkBranchInput.value = 'main';
prefillForkBranch({ dataset: { agent: 'do' }, closest: () => forkForm }, { id: 'task_source', params: { target: 'release' }, lastView: { status: 'waiting', branch: 'tavya/source' } });
ok(forkBranchInput.value === 'release', 'a source that is already a dependency fills the branch it lands on');
global.document.querySelectorAll = () => [];

ok(forkBranchDefaults({ lastView: { status: 'waiting', branch: 'tavya/source', targetBranch: 'release' } }, true).base === 'release', 'a fork awaiting its source starts where the source lands');
ok(!forkBranchDefaults({ lastView: { status: 'waiting', branch: 'tavya/source' } }, true).base, 'a fork awaiting a source with no known target keeps ordinary defaults');
const retargetInput = { value: 'tavya/source', dataset: { inherit: '"main"' }, dispatchEvent: () => retargets++ };
const retargetForm = { querySelector: () => retargetInput };
const unlanded = { lastView: { status: 'waiting', branch: 'tavya/source' } };
let retargets = 0;
retargetForkBase(retargetForm, unlanded, true);
ok(retargetInput.value === 'main' && retargets === 1, 'adding the source as a dependency resets the fork branch to the default');
retargetForkBase(retargetForm, unlanded, false);
ok(retargetInput.value === 'tavya/source' && retargets === 2, 'dropping that dependency restores the fork branch');
retargetInput.value = 'feature/mine';
retargetForkBase(retargetForm, unlanded, true);
retargetForkBase(retargetForm, unlanded, false);
ok(retargetInput.value === 'feature/mine' && retargets === 2, 'a manually chosen base branch is never replaced');

const closed = renderAgentField({ role: 'do', name: 'agent:do' }, undefined, { provider: 'claude' });
ok(closed.includes('type="checkbox" class="af-resume-enabled"'), 'fork disclosure is a checkbox');
ok(closed.includes('class="af-resume-panel" hidden'), 'unchecked fork panel starts collapsed');
ok(!closed.includes('<details class="af-resume') && closed.includes('af-resume-enabled'), 'fork choice uses its explicit toggle');
ok(closed.includes('provider conversation ID or a ChatGPT, Claude or tavya share link'), 'a local console advertises provider ids and share links');
ok(closed.includes('Upload conversation'), 'conversation upload is offered without another panel');

S.meta.hostLocal = false;
const hosted = renderAgentField({ role: 'do', name: 'agent:do' }, undefined, { provider: 'claude' });
ok(hosted.includes('paste a ChatGPT, Claude or tavya share link'), 'a nonlocal console still advertises share links');
ok(!hosted.includes('provider conversation ID'), 'a nonlocal console does not advertise inaccessible provider ids');
S.meta.hostLocal = true;

const existing = renderAgentField(
  { role: 'do', name: 'agent:do' },
  { provider: 'codex', model: 'gpt-source', effort: 'high', resumeFrom: { taskId: 'task_source', role: 'do' } },
  {},
);
ok(existing.includes('class="af-resume-enabled" checked'), 'an already-selected task fork checks the box');
ok(existing.includes('class="af-resume-panel" >'), 'an already-selected task fork starts expanded');
ok(existing.includes('value="codex:gpt-source:high"'), 'existing fork parameters remain visible');

// ── the chosen-source chip: a permalink to the source + the re-authorize option
const source = {
  id: 'task_source', num: 42, title: 'Ship <billing>', projectId: 'p1',
  params: { _authorization: { level: 'maintainer', scope: 'projects', projectIds: ['p1', 'p2'],
    capabilities: ['task:*', 'use-credential:item:cred_a', 'use-credential:item:cred_b', 'use-credential:domain:example.com'],
    credentialPolicies: { cred_a: { use: 'ask' } } } },
};
const chip = resumeChosenInner({ taskId: 'task_source', role: 'do' }, source);
ok(chip.includes('<a class="af-resume-source" data-spa href="/acme/p1/tasks/42"'), 'the "fork of" text links to the source task');
ok(chip.includes('>#42 Ship &lt;billing&gt;</a>'), 'the link carries the task number and escaped title');
ok(chip.includes('class="af-resume-reuse-model"') && chip.includes('Re-use same AI model'), 'known task offers model reuse');
ok(!chip.includes('class="af-resume-reuse-model" checked'), 'model reuse starts unchecked');
ok(resumeChosenInner({ taskId: 'missing' }).includes('af-resume-reuse-model'), 'saved forks can reuse a source outside the current task list');
ok(chip.includes('class="af-resume-clear"'), 'the chip keeps its clear button');
ok(chip.includes('class="af-resume-reauthorize"') && chip.includes('Re-authorize previous grants?'), 'a source with known grants offers to re-authorize them');
ok(chip.includes('class="af-resume-reauth" hidden'), 'the option starts hidden until a form with grant controls claims it');
ok(chip.includes('Project maintainer · Website, Billing + 2 credentials'), 'the option summarizes the level, scope and vault item grants it would apply');
ok(resumeChosenInner({ taskId: 'task_source', role: 'confirm' }, source).includes('forking confirm agent of'), 'non-do roles are named');
const noGrants = resumeChosenInner({ taskId: 'task_legacy' }, { id: 'task_legacy', num: 7, title: 'Legacy', projectId: 'p1', params: {} });
ok(noGrants.includes('href="/acme/p1/tasks/7"') && !noGrants.includes('af-resume-reauthorize'), 'a source without stored grants links but offers nothing to re-authorize');
const foreign = resumeChosenInner({ taskId: 'task_far' }, { id: 'task_far', num: 3, title: 'Far', projectId: 'p_unknown', params: {} });
ok(!foreign.includes('<a ') && foreign.includes('#3 Far'), 'a source in an unloaded project stays plain text rather than a dead link');
ok(resumeChosenInner({ taskId: 'task_gone' }).includes('task_gone') && !resumeChosenInner({ taskId: 'task_gone' }).includes('<a '), 'an unknown source shows its id without a link');
const grants = previousTaskGrants(source);
ok(JSON.stringify(grants.authorization) === JSON.stringify({ level: 'maintainer', scope: 'projects', projectIds: ['p1', 'p2'] }), 'previous grants carry the stored selection');
ok(grants.credentialGrantIds.join() === 'cred_a,cred_b' && grants.credentialPolicies.cred_a.use === 'ask', 'previous grants carry vault item grants + policies (domain/tag caps are not pickable here)');
ok(previousTaskGrants({ projectId: 'p1', params: { _authorization: { profileId: 'developer' } } }).authorization.projectIds[0] === 'p1', 'a legacy profileId-only record falls back to its own project');

const listeners = new Map();
const element = (extra = {}) => ({
  value: '', disabled: false, checked: false, hidden: false, dataset: {}, innerHTML: '', options: [],
  addEventListener(type, fn) { listeners.set(`${this.key}:${type}`, fn); },
  ...extra,
});
// The model field, as the one harness:model:effort value it holds.
const ref = element({ key: 'ref', value: 'claude' });
const controls = element({ key: 'controls', querySelector: () => null });
const enabled = element({ key: 'enabled' });
const panel = element({ key: 'panel' });
// The chip container: its innerHTML is re-rendered by the box, so model the two
// elements the box later queries inside it (the option label + its checkbox).
const chosen = element({ key: 'chosen', dataset: { resume: 'null' } });
chosen.option = { hidden: true };
chosen.checkbox = { checked: false, closest: (sel) => sel === '.af-resume-reauthorize' ? chosen.checkbox : null };
let chosenHtml = '';
Object.defineProperty(chosen, 'innerHTML', {
  get: () => chosenHtml,
  set: (html) => { chosenHtml = html; chosen.option.hidden = html.includes('class="af-resume-reauth" hidden'); chosen.checkbox.checked = false; },
});
chosen.querySelector = (sel) => !chosenHtml.includes(sel.slice(1)) ? null
  : sel === '.af-resume-reauth' ? chosen.option : sel === '.af-resume-reauthorize' ? chosen.checkbox : null;
const pick = element({ key: 'pick' });
const sessionInput = element({ key: 'session', value: '' });
const uploadInput = element({ key: 'upload-input', files: [] });
const uploaded = element({ key: 'uploaded', dataset: { upload: 'null' } });
const classes = new Set();
// The hosting form (task form / task page): claims the option and applies grants.
const hostListeners = new Map();
const hostRoot = { dataset: {}, querySelectorAll: () => [], addEventListener(type, fn) { hostListeners.set(type, fn); } };
let hostAttached = false;
const dispatched = [];
const box = {
  addEventListener() {},
  dataset: { agent: 'do' },
  querySelector(selector) {
    return {
      '.agent-controls': controls, '.af-resume-enabled': enabled, '.af-resume-panel': panel,
      '.af-resume-chosen': chosen, '.af-resume-pick': pick, '.af-resume-session': sessionInput,
      '.af-resume-upload input': uploadInput, '.af-resume-uploaded': uploaded,
    }[selector];
  },
  closest: (sel) => sel === '[data-reauthorize-host]' && hostAttached ? hostRoot : null,
  classList: { toggle(name, on) { on ? classes.add(name) : classes.delete(name); } },
  dispatchEvent(event) { dispatched.push(event.type); if (event.type === 'af-reauthorize') hostListeners.get('af-reauthorize')?.(event); },
};
global.wireModelField = () => {};
global.setModelField = (_root, spec) => { ref.value = [spec.provider, spec.model, spec.effort].filter(Boolean).join(':'); };
global.readModelField = () => { const [provider, model = '', effort = ''] = ref.value.split(':'); return { provider, model, effort }; };
global.Event = class Event { constructor(type) { this.type = type; } };
let picker;
global.openTaskPicker = (config) => { picker = config; };
eval(extractFn('wireAgentBox'));

wireAgentBox(box);
ok(panel.hidden && !ref.disabled, 'unchecked box is collapsed and provider is editable');
enabled.checked = true;
listeners.get('enabled:change')();
ok(!panel.hidden && !ref.disabled, 'checking expands before a source agent is selected');
listeners.get('pick:click')();
picker.onPick({
  task: { id: 'task_source', num: 42, title: 'Source', projectId: 'p1' }, role: 'do',
  session: { id: 'session-1', provider: 'codex', model: 'gpt-source', effort: 'high' },
});
ok(ref.value === 'claude' && !ref.disabled, 'source selection leaves the destination agent editable, without overwriting its model');
ok(readResume(box)?.taskId === 'task_source', 'checked selection is collected as a task fork');
ok(chosen.innerHTML.includes('href="/acme/p1/tasks/42"'), 'the picked source renders as a link even when the task list does not hold it');
ok(!chosen.innerHTML.includes('af-resume-reauthorize'), 'a picked source without grants offers nothing to re-authorize');
sessionInput.value = 'https://chatgpt.com/share/example';
listeners.get('session:input')();
ok(readResume(box)?.sessionId === 'https://chatgpt.com/share/example', 'share links use the provider conversation input');
ok(chosen.dataset.resume === 'null', 'typing an id or link clears the task source');
sessionInput.value = '';
uploaded.dataset.upload = JSON.stringify({ id: 'a'.repeat(64), name: 'session.jsonl', bytes: 42, format: 'codex', projectId: 'project' });
ok(readResume(box)?.upload?.format === 'codex', 'an uploaded conversation is collected as the sole source');
enabled.checked = false;
listeners.get('enabled:change')();
ok(panel.hidden && !ref.disabled, 'unchecking collapses the panel and unlocks provider customization');
ok(readResume(box) === undefined, 'unchecked fork is omitted from submitted parameters');
enabled.checked = true;
listeners.get('enabled:change')();
ok(!ref.disabled && readResume(box) === undefined, 'rechecking does not revive a stale source');

// ── re-authorize: outside a grant-hosting form the option stays hidden
picker.onPick({ task: source, role: 'do', session: { id: 'session-1', provider: 'codex' } });
ok(chosen.innerHTML.includes('af-resume-reauthorize') && chosen.option.hidden, 'without a hosting form the option is rendered but hidden');
ok(readResume(box)?.taskId === 'task_source' && !('reauthorize' in readResume(box)), 'the option is not part of the submitted resume pointer');

// ── re-authorize inside a hosting form: grants land in the form's own controls
const editorCalls = [];
const editor = { _authorizationValue: { level: 'developer', scope: 'projects', projectIds: ['p1'] },
  _setAuthorization(value) { editorCalls.push(value); this._authorizationValue = value; } };
let formGrants = { ids: [], policies: {} };
let changed = 0;
wireResumeReauthorization(hostRoot, {
  editor: () => editor,
  grants: () => ({ ids: [...formGrants.ids], policies: formGrants.policies }),
  setGrants: (ids, policies) => { formGrants = { ids, policies }; },
  changed: () => changed++,
});
ok('reauthorizeHost' in hostRoot.dataset, 'a hosting form claims the option');
hostAttached = true;
picker.onPick({ task: source, role: 'do', session: { id: 'session-1', provider: 'codex' } });
ok(!chosen.option.hidden, 'inside a hosting form the option is shown');
chosen.checkbox.checked = true;
listeners.get('chosen:change')({ target: chosen.checkbox });
ok(editorCalls.length === 1 && editorCalls[0].level === 'maintainer' && editorCalls[0].projectIds.join() === 'p1,p2', 'checking applies the source level + scope to the Authorization editor');
ok(formGrants.ids.join() === 'cred_a,cred_b' && formGrants.policies.cred_a.use === 'ask', 'checking applies the source vault grants + policies');
ok(changed === 1, 'the host is told to persist the change');
chosen.checkbox.checked = false;
listeners.get('chosen:change')({ target: chosen.checkbox });
ok(editorCalls.length === 2 && editorCalls[1].level === 'developer' && editorCalls[1].projectIds.join() === 'p1', 'unchecking restores the previous selection');
ok(formGrants.ids.length === 0 && changed === 2, 'unchecking restores the previous vault grants');
listeners.get('chosen:change')({ target: chosen.checkbox });
ok(editorCalls.length === 2 && changed === 2, 'a redundant uncheck is a no-op');
chosen.checkbox.checked = true;
listeners.get('chosen:change')({ target: chosen.checkbox });
ok(formGrants.ids.join() === 'cred_a,cred_b', 'grants can be applied again');
listeners.get('chosen:click')({ target: { closest: (sel) => sel === '.af-resume-clear' ? {} : null } });
ok(chosen.dataset.resume === 'null' && formGrants.ids.length === 0 && editorCalls.at(-1).level === 'developer', 'clearing the source withdraws the grants it brought');
picker.onPick({ task: source, role: 'do', session: { id: 'session-1', provider: 'codex' } });
chosen.checkbox.checked = true;
listeners.get('chosen:change')({ target: chosen.checkbox });
enabled.checked = false;
listeners.get('enabled:change')();
ok(formGrants.ids.length === 0 && editorCalls.at(-1).level === 'developer', 'turning the fork off withdraws re-authorized grants too');

// The fork checkbox shares the normal dependency state and serialized triggers.
for (const status of ['running', 'waiting', 'failed', 'cancelled']) {
  ok(resumeChosenInner({ taskId: source.id, role: 'do' }, { ...source, lastView: { status } }).includes('Also add as dependency?'), `${status} source offers a dependency`);
}
ok(!resumeChosenInner({ taskId: source.id }, { ...source, lastView: { status: 'done' } }).includes('Also add as dependency?'), 'done source needs no dependency');
ok(!resumeChosenInner({ taskId: 'unknown' }).includes('Also add as dependency?'), 'unknown source does not guess its completion state');
eval(extractFn('dependencyChipHtml'));
eval(extractFn('wireDepPicker'));
eval(extractFn('collectTriggers'));
global.numberedTaskTitle = (task) => task.title;
let depIds = [], depChange, depPickerClick;
const depLabel = { hidden: true };
const depInput = {
  dataset: { taskId: source.id }, checked: false,
  closest: (selector) => selector === '.af-resume-dependency' ? depLabel : selector === '.af-resume-add-dependency' ? depInput : { _sourceTask: source },
};
const depRoot = {
  dataset: {}, querySelectorAll: () => [depInput], querySelector: () => null,
  addEventListener: (_type, callback) => { depChange = callback; },
};
const depBox = {
  set innerHTML(html) { depIds = [...html.matchAll(/data-depid="([^"]+)"/g)].map((match) => match[1]); },
  querySelectorAll: () => [], closest: () => depRoot,
  dispatchEvent: () => depChange({ target: { closest: () => null } }),
};
global.document = { querySelectorAll: () => depIds.map((id) => ({ dataset: { depid: id } })) };
global.$ = (selector) => selector === '#dep-chips' ? depBox : selector === '#dep-add' ? { addEventListener: (_type, callback) => { depPickerClick = callback; } } : null;
global.readCronCells = () => ['*', '*', '*', '*', '*'];
wireDepPicker({ triggers: [{ kind: 'dependency', tasks: ['manual'] }] });
ok(!depLabel.hidden && !depInput.checked, 'unfinished fork option is visible and opt-in');
depInput.checked = true;
depChange({ target: depInput });
ok(depIds.join() === `manual,${source.id}`, 'checking preserves existing dependencies and adds source');
ok(collectTriggers([])[0].tasks.includes(source.id), 'source is serialized in the normal task dependency trigger');
depChange({ target: depInput });
ok(depIds.length === 2, 'checking never duplicates the dependency');
depInput.checked = false;
depChange({ target: depInput });
ok(depIds.join() === 'manual', 'unchecking removes only the source dependency');
depPickerClick();
picker.onPick(source);
ok(depInput.checked, 'manual picker additions update the fork checkbox');
wireDepPicker({ triggers: [{ kind: 'dependency', tasks: [source.id] }] });
ok(depInput.checked, 'reopening a saved draft restores the checked state');
wireDepPicker({}, source.id);
ok(depLabel.hidden, 'a task cannot select itself as a dependency');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
