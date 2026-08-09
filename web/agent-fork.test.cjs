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

global.esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
global.inhAttr = (v) => `data-inherit='${esc(JSON.stringify(v ?? null))}'`;
global.effortSelectHtml = (_cls, _provider, _model, effort) => `<select class="af-effort"><option selected>${effort || ''}</option></select>`;
global.AGENT_PROVIDERS = ['claude', 'codex', 'opencode', 'mock'];
global.agentProviderChoice = (provider) => AGENT_PROVIDERS.includes(provider) ? provider : AGENT_PROVIDERS[0];
global.S = { tasks: [] };
eval(extractFn('resumeChosenInner'));
eval(extractFn('renderAgentField'));
eval(extractFn('readResume'));

let pass = 0;
let fail = 0;
const ok = (condition, message) => condition ? pass++ : (fail++, console.error('FAIL:', message));

const closed = renderAgentField({ role: 'do', name: 'agent:do' }, undefined, { provider: 'claude' });
ok(closed.includes('type="checkbox" class="af-resume-enabled"'), 'fork disclosure is a checkbox');
ok(closed.includes('class="af-resume-panel" hidden'), 'unchecked fork panel starts collapsed');
ok(!closed.includes('<details') && !closed.includes('<summary'), 'old details disclosure is gone');
ok(closed.includes('Upload conversation'), 'Codex and Claude conversation files can be uploaded');
ok(closed.includes('provider conversation ID or a ChatGPT/Claude share link'), 'provider ids and public share links use one compact field');

const existing = renderAgentField(
  { role: 'do', name: 'agent:do' },
  { provider: 'codex', model: 'gpt-source', effort: 'high', resumeFrom: { taskId: 'task_source', role: 'do' } },
  {},
);
ok(existing.includes('class="af-resume-enabled" checked'), 'an already-selected task fork checks the box');
ok(existing.includes('class="af-resume-panel" >'), 'an already-selected task fork starts expanded');
ok(existing.includes('value="gpt-source"'), 'existing fork parameters remain visible');
const imported = renderAgentField(
  { role: 'do', name: 'agent:do' },
  { provider: 'claude', resumeFrom: { importId: 'abc', importName: 'session.jsonl' } },
  {},
);
ok(imported.includes('class="af-resume-enabled" checked') && imported.includes('session.jsonl'), 'an uploaded conversation is restored as the visible source');

const listeners = new Map();
const element = (extra = {}) => ({
  value: '', disabled: false, checked: false, hidden: false, dataset: {}, innerHTML: '', options: [],
  addEventListener(type, fn) { listeners.set(`${this.key}:${type}`, fn); },
  ...extra,
});
const provider = element({ key: 'provider', value: 'claude' });
const model = element({ key: 'model', value: '' });
const effort = element({ key: 'effort', value: '', options: [{ value: '' }, { value: 'high' }] });
const enabled = element({ key: 'enabled' });
const panel = element({ key: 'panel' });
const chosen = element({ key: 'chosen', dataset: { resume: 'null' } });
const pick = element({ key: 'pick' });
const sessionInput = element({ key: 'session', value: '' });
const upload = element({ key: 'upload' });
const fileInput = element({ key: 'file', files: [], click() {} });
const classes = new Set();
const box = {
  querySelector(selector) {
    return {
      '.af-model-combo': null, '.af-provider': provider, '.af-model': model,
      '.af-effort': effort, '.af-resume-enabled': enabled, '.af-resume-panel': panel,
      '.af-resume-chosen': chosen, '.af-resume-pick': pick, '.af-resume-session': sessionInput,
      '.af-resume-upload': upload, '.af-resume-file': fileInput,
    }[selector];
  },
  classList: { toggle(name, on) { on ? classes.add(name) : classes.delete(name); } },
  dispatchEvent() {},
};
global.wireCombo = () => {};
global.modelOptions = () => [];
global.refreshEffortSelect = () => {};
let picker;
global.openTaskPicker = (config) => { picker = config; };
global.uploadConversation = async () => ({});
global.toast = () => {};
eval(extractFn('wireAgentBox'));

wireAgentBox(box);
ok(panel.hidden && !provider.disabled, 'unchecked box is collapsed and provider is editable');
enabled.checked = true;
listeners.get('enabled:change')();
ok(!panel.hidden && !provider.disabled, 'checking expands before a source agent is selected');
listeners.get('pick:click')();
picker.onPick({
  task: { id: 'task_source', num: 42, title: 'Source' }, role: 'do',
  session: { id: 'session-1', provider: 'codex', model: 'gpt-source', effort: 'high' },
});
ok(provider.value === 'claude' && !provider.disabled, 'source selection leaves the new agent provider editable');
ok(model.value === '' && !model.disabled, 'source selection leaves the new agent model unchanged');
ok(effort.value === '' && !effort.disabled, 'source selection leaves reasoning effort unchanged');
ok(readResume(box)?.taskId === 'task_source', 'checked selection is collected as a task fork');
enabled.checked = false;
listeners.get('enabled:change')();
ok(panel.hidden && !provider.disabled, 'unchecking collapses the panel and preserves provider customization');
ok(readResume(box) === undefined, 'unchecked fork is omitted from submitted parameters');
enabled.checked = true;
listeners.get('enabled:change')();
ok(!provider.disabled && readResume(box) === undefined, 'rechecking does not revive a stale source or re-lock the customized provider');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
