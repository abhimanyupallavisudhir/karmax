// Regression coverage for the task form's compact vault credential picker.
// Run: node web/vault-grants.test.cjs
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, 'styles.css'), 'utf8');

function extractFn(name, async = false) {
  const start = src.indexOf(`${async ? 'async ' : ''}function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  // Skip the parameter list: it may destructure options (`{ single = false }`).
  let parens = 0;
  let body = -1;
  for (let i = src.indexOf('(', start); i < src.length; i++) {
    if (src[i] === '(') parens++;
    else if (src[i] === ')') parens--;
    else if (src[i] === '{' && parens === 0) { body = i; break; }
  }
  let depth = 0;
  for (let i = body; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

const taskForm = extractFn('openTaskForm', true);
const picker = extractFn('openVaultGrantPicker');
const passwords = extractFn('passwordsCard');
const vaultCards = extractFn('wireVaultCards', true);
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
ok(taskForm.includes('credentialGrants: inheritedVault.error ? undefined : [...vaultGrantIds]'), 'selected grants are included in task persistence');
ok(taskForm.includes('credentialPolicies: inheritedVault.error ? undefined : vaultCredentialPolicies'), 'task-specific policies are included in task persistence');

ok(picker.includes('class="vault-grant-all"'), 'picker offers Select all');
ok(picker.includes('class="vault-grant-pick"'), 'picker offers individual selection');
ok(picker.includes('class="vault-search"'), 'task picker offers credential search');
ok(picker.includes('class="vault-task-use"'), 'task picker offers blind-use overrides');
ok(picker.includes('class="vault-task-reveal"'), 'task picker offers agent-sees overrides');
ok(picker.includes('inherit ('), 'task policy controls can inherit organization defaults');
ok(picker.includes('data-vault-cancel'), 'picker offers Cancel');
ok(picker.includes('data-vault-apply'), 'picker offers Apply');
ok(picker.includes('all.indeterminate'), 'picker reflects partial selection');
ok(css.includes('.vault-grant-tree { max-height: 44vh; overflow-y: auto;'), 'picker list is bounded and scrollable');

ok(passwords.includes('id="vault-manage-open"'), 'settings renders one compact vault manager button');
ok(!passwords.includes('class="vault-items-list"'), 'settings no longer renders the item list inline');
ok(vaultCards.includes('class="modal-card vault-manager-modal"'), 'settings button opens a full vault manager');
ok(vaultCards.includes('class="vault-search"'), 'settings manager offers credential search');
ok(vaultCards.includes('data-vi-rotate'), 'settings manager retains secret rotation');
ok(vaultCards.includes('data-vi-reveal'), 'settings manager lets a vault administrator inspect a credential');
ok(vaultCards.includes('/reveal'), 'settings manager uses the audited administrative reveal endpoint');
ok(vaultCards.includes('Every reveal is recorded in the audit log'), 'settings manager explains that plaintext inspection is audited');
ok(vaultCards.includes('data-vi-del'), 'settings manager retains deletion');
ok(vaultCards.includes('class="vi-pol-use"'), 'settings manager retains global policy actions');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
