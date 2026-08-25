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
ok(taskModal.includes('codex fork') && taskModal.includes('--fork-session'), 'hosted handoff includes Codex and Claude fork commands');
ok(taskModal.includes('localConversationHandoff(v,'), 'hosted task checkout renders agent handoffs');
ok(projectModal.includes('/checkout`'), 'project action loads a server-generated checkout plan');
ok(projectModal.includes('plan.cloneScript') && projectModal.includes('plan.updateScript'), 'project modal offers clone and update commands');
ok(localModal.includes('localConversationHandoff(v, checkout.cwd)'), 'local materialization renders agent handoffs');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
