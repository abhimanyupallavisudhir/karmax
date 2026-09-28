// Hosted checkout actions stay attached to both persistent tab rails.
// Run: node web/work-locally.test.cjs
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
let pass = 0, fail = 0;
function ok(condition, message) {
  if (condition) pass++;
  else { fail++; console.error('FAIL:', message); }
}
const slice = (from, to) => {
  const start = src.indexOf(from);
  const end = src.indexOf(to, start + from.length);
  if (start < 0 || end < 0) throw new Error(`missing slice ${from} → ${to}`);
  return src.slice(start, end);
};

const main = slice('function renderMain()', '// ── tasks');
const task = slice('function renderTaskPage()', '// A text walker');
const terminal = slice('function terminalPane(v)', 'async function openLocalCheckout(v)');
const taskModal = slice('function nativeConversationFilename(session)', 'async function openProjectCheckout(project)');
const projectModal = slice('async function openProjectCheckout(project)', 'async function materializeLocalCheckout');
const localModal = slice('async function materializeLocalCheckout', 'async function forkCloudSessionLocally');

ok(main.includes('id="project-local-checkout"'), 'project tab rail includes Work locally');
ok(main.includes("S.meta?.hosted"), 'project action is hosted-only');
ok(task.includes('id="local-checkout"'), 'task tab rail includes Work locally');
ok(task.includes("S.meta?.hosted"), 'task action is hosted-only');
ok(!terminal.includes('id="local-checkout"'), 'terminal pane does not duplicate the task action');
ok(taskModal.includes('Download conversation'), 'task handoff offers a native conversation download');
ok(taskModal.includes('/conversation.jsonl?role='), 'download is scoped to the selected agent role');
ok(!taskModal.includes('session?.home &&'), 'API-backed conversations are not hidden when they lack a config home');
ok(taskModal.includes('session?.downloadable'), 'server-confirmed generated or retained histories are offered');
ok(taskModal.includes('@openai/codex@') && taskModal.includes('--fork-session'), 'hosted handoff includes Codex and Claude fork commands');
ok(taskModal.includes('localConversationHandoff(v,'), 'hosted task checkout renders agent handoffs');
ok(projectModal.includes('/checkout`'), 'project action loads a server-generated checkout plan');
ok(projectModal.includes('plan.cloneScript') && projectModal.includes('plan.updateScript'), 'project modal offers clone and update commands');
ok(localModal.includes('localConversationHandoff(v, checkout.cwd,'), 'local materialization renders agent handoffs');

// Execute the command builder against a bound snapshot, including shell metacharacters.
const vm = require('node:vm');
const snapshot = { id: 'old-session', exportId: '11111111-1111-4111-8111-111111111111', provider: 'codex',
  filename: 'rollout-2026-09-09T00-00-00-11111111-1111-4111-8111-111111111111.jsonl', requiredCodexVersion: '0.154.0-alpha.11' };
const context = { snapshot, cwd: "/tmp/user's checkout $(false)" };
vm.runInNewContext(slice('function nativeConversationFilename(session)', 'async function downloadNativeConversation')
  + '\nresult = portableForkCommandFor(snapshot, cwd);', context);
ok(context.result.includes(`sessions/tavya/${snapshot.filename}`), 'copy preserves the canonical filename');
ok(context.result.includes('@openai/codex@0.154.0-alpha.11 fork'), 'fork uses the decoder-fixed pinned CLI');
ok(context.result.includes(snapshot.exportId) && !context.result.includes('old-session'), 'fork identity matches the downloaded snapshot');
ok(require('child_process').spawnSync('bash', ['-n', '-c', context.result]).status === 0, 'commands safely quote paths containing shell metacharacters');

// PA-6: a download that panagent converted lossily says what changed.
(async () => {
  const toasts = [];
  const warnings = encodeURIComponent(JSON.stringify([{ code: 'codex_system_role_mapped', message: 'System messages were mapped to Codex developer messages.' }]));
  const button = { disabled: false, textContent: 'Download conversation', isConnected: true,
    dataset: { url: '/api/tasks/t/conversation.jsonl?role=do', filename: 'x.jsonl' } };
  const download = { S: {}, button, toasts, URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} }, setTimeout() {},
    document: { createElement: () => ({ click() {}, remove() {} }), body: { appendChild() {} } },
    toast: (message, error) => toasts.push({ message, error }),
    feedbackFetch: async () => ({ ok: true, blob: async () => ({}),
      headers: { get: (name) => name === 'x-karmax-conversation-warnings' ? warnings : null } }) };
  vm.runInNewContext(slice('async function downloadNativeConversation', 'function localConversationHandoff')
    + '\nresult = downloadNativeConversation(button);', download);
  await download.result;
  ok(button.textContent === '✓ Downloaded', 'the warned download still completes');
  ok(toasts.length === 1 && !toasts[0].error && toasts[0].message.includes('System messages were mapped to Codex developer messages.'),
    'conversion warnings are shown after the download');

  // Several kinds of change stay one short line: the first, then a count.
  const many = encodeURIComponent(JSON.stringify([
    { code: 'a', message: 'System messages were mapped to Codex developer messages.' },
    { code: 'b', message: 'Reasoning summaries were converted to labelled message text.', count: 12 },
    { code: 'c', message: 'Image or attachment references were converted to labelled text.' },
  ]));
  toasts.length = 0;
  download.feedbackFetch = async () => ({ ok: true, blob: async () => ({}),
    headers: { get: (name) => name === 'x-karmax-conversation-warnings' ? many : null } });
  vm.runInNewContext('result = downloadNativeConversation(button);', download);
  await download.result;
  ok(toasts.length === 1 && toasts[0].message === 'Converted with changes: System messages were mapped to Codex developer messages. (+2 more)',
    'several conversion warnings collapse into one short toast');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
