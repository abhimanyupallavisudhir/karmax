// The people and task forms share one compact authorization-level editor.
// Run: node web/authorization-editor.test.cjs
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, 'styles.css'), 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0;
  for (let index = source.indexOf('{', start); index < source.length; index++) {
    if (source[index] === '{') depth++;
    else if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

const authorizationLevels = Function(`${extractFunction('authorizationLevels')}; return authorizationLevels;`)();
const authorizationScopeSuggestions = Function(
  `${extractFunction('authorizationScopeSuggestions')}; return authorizationScopeSuggestions;`,
)();

let passed = 0;
let failed = 0;
const ok = (condition, message) => {
  if (condition) passed++;
  else { failed++; console.error('FAIL:', message); }
};

ok(authorizationLevels().map((level) => level.name).join('|') ===
  'Viewer|Developer|Project maintainer|Administrator|God', 'shows exactly the five canonical levels');
ok(!source.includes('Automation operator</option>'), 'removes Automation operator from authorization selectors');

const suggestions = authorizationScopeSuggestions([
  { id: 'p2', name: 'Beta' }, { id: 'p1', name: 'Alpha' },
], '');
ok(suggestions[0].value === '@organization', '@organization is the first scope suggestion');
ok(suggestions.slice(1).map((option) => option.label).join('|') === 'Alpha|Beta', 'project suggestions follow by name');
ok(authorizationScopeSuggestions([{ id: 'p1', name: 'Alpha' }, { id: 'p2', name: 'Beta' }], 'alp')
  .map((option) => option.label).join('|') === 'Alpha', 'scope suggestions filter as the user types');

const editor = extractFunction('authorizationEditorHtml');
ok(editor.includes('authz-level-select'), 'shared editor contains the authorization-level select');
ok(editor.includes('authz-scope-input'), 'shared editor contains the filtering scope text field');
ok(editor.includes('authz-scope-menu'), 'shared editor contains a real suggestion dropdown');
ok(source.match(/authorizationEditorHtml\(/g).length >= 3, 'organization people, invitations, and task forms reuse the editor');
ok(source.includes("level.scope === 'selectable'"), 'scope input only appears for Viewer, Developer, and Project maintainer');
ok(css.includes('.authz-editor'), 'shared editor has dedicated visual styling');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
