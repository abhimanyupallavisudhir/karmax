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
const projectModal = slice('async function openProjectCheckout(project)', 'async function materializeLocalCheckout');

ok(main.includes('id="project-local-checkout"'), 'project tab rail includes Work locally');
ok(main.includes("S.meta?.hosted"), 'project action is hosted-only');
ok(task.includes('id="local-checkout"'), 'task tab rail includes Work locally');
ok(task.includes("S.meta?.hosted"), 'task action is hosted-only');
ok(!terminal.includes('id="local-checkout"'), 'terminal pane does not duplicate the task action');
ok(projectModal.includes('/checkout`'), 'project action loads a server-generated checkout plan');
ok(projectModal.includes('plan.cloneScript') && projectModal.includes('plan.updateScript'), 'project modal offers clone and update commands');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
