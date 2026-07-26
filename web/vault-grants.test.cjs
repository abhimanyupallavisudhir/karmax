// Regression coverage for the task form's compact vault credential picker.
// Run: node web/vault-grants.test.cjs
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, 'styles.css'), 'utf8');

function extractFn(name, async = false) {
  const start = src.indexOf(`${async ? 'async ' : ''}function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0;
  const body = src.indexOf('{', start);
  for (let i = body; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

const taskForm = extractFn('openTaskForm', true);
const picker = extractFn('openVaultGrantPicker');
let pass = 0;
let fail = 0;
const ok = (condition, message) => {
  if (condition) pass++;
  else { fail++; console.error('FAIL:', message); }
};

ok(taskForm.includes('id="tf-vault-open"'), 'task form renders one Vault credentials button');
ok(!taskForm.includes('id="tf-vault-grants"'), 'task form no longer renders the inline vault list');
ok(!taskForm.includes('class="tf-vault-grant"'), 'task form no longer renders one checkbox per vault item');
ok(taskForm.includes('const vaultGrantIds = new Set'), 'selected grants live in compact form-local state');
ok(taskForm.includes('credentialGrants: [...vaultGrantIds]'), 'selected grants are included in task persistence');

ok(picker.includes('class="vault-grant-all"'), 'picker offers Select all');
ok(picker.includes('class="vault-grant-pick"'), 'picker offers individual selection');
ok(picker.includes('data-vault-cancel'), 'picker offers Cancel');
ok(picker.includes('data-vault-apply'), 'picker offers Apply');
ok(picker.includes('all.indeterminate'), 'picker reflects partial selection');
ok(css.includes('.vault-grant-tree { max-height: 44vh; overflow-y: auto;'), 'picker list is bounded and scrollable');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
