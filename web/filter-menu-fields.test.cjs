// The task list's Filter / Group / Sort menus offer workflow parameters as
// task attributes. Only parameters a task can carry belong there: installation
// and project settings ("Concurrent agent turns", "Remote policy", …) and the
// Review/Responder routing made the menus 31/34/59 entries long on a fresh
// project. Run: node web/filter-menu-fields.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
function fn(name) {
  const start = src.search(new RegExp(`^function ${name}\\(`, 'm'));
  if (start < 0) throw new Error(`Missing function: ${name}`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`Unterminated function: ${name}`);
}
function constant(name) {
  const match = src.match(new RegExp(`^const ${name} = .*?;$`, 'ms'));
  if (!match) throw new Error(`Missing constant: ${name}`);
  return match[0];
}

const S = {
  schema: [
    { name: 'software-dev', params: [
      { name: 'prompt', type: 'text', scopes: ['task'] },
      { name: 'agent:do', type: 'agent', label: 'Agent', scopes: ['task'] },
      { name: 'confirm', type: 'confirmer', label: 'Review route', scopes: ['task', 'project', 'global'] },
      { name: 'responder', type: 'responder', label: 'Responder', scopes: ['task', 'project', 'global'] },
      { name: 'base', type: 'branch', label: 'Base (branch-from) branch', scopes: ['task', 'project', 'global'] },
      { name: 'remote', type: 'select', label: 'Remote policy', options: ['none', 'push', 'pr'], scopes: ['project', 'global'] },
      { name: 'otherAttempts', type: 'select', label: 'Other task attempts', scopes: ['project'] },
      { name: 'repos', type: 'list', label: 'Repositories', scopes: ['project'] },
    ] },
    { name: 'script', params: [{ name: 'command', type: 'text', label: 'Command', scopes: ['task'] }] },
    { name: 'agent-queue', kind: 'coordinator', params: [
      { name: 'capacity', type: 'number', label: 'Concurrent agent turns', scopes: ['global'] },
    ] },
    // A package manifest that predates `scopes` still contributes its fields.
    { name: 'legacy-package', params: [{ name: 'target', type: 'branch', label: 'Target' }] },
  ],
};

const paramMenuFields = Function('S', `${constant('PARAM_SCALAR_SKIP')}
${constant('PARAM_NAME_SKIP')}
${constant('AGENT_SUBFIELDS')}
${fn('paramMenuFields')}
return paramMenuFields;`)(S);

const labels = paramMenuFields().map((field) => field.label);
assert.deepEqual(labels, [
  'Agent · agent', 'Agent · model', 'Agent · effort',
  'Base (branch-from) branch',
  'Command',
  'Target',
]);
console.log('filter menu fields: ok');
