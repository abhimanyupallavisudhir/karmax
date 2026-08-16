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

// The control reads as a label, a level, and then ONE scope field: chips and the
// text cursor live in the same box, so there is no second boxed input carrying a
// hint next to the already-chosen scopes.
const authorizationEditorHtmlFn = Function(`
  const esc = (value) => String(value);
  ${extractFunction('authorizationLevels')}
  ${extractFunction('normalizedAuthorization')}
  ${extractFunction('authorizationScopePlaceholder')}
  ${editor}
  return authorizationEditorHtml;
`)();
const authorizationScopePlaceholder = Function(
  `${extractFunction('authorizationScopePlaceholder')}; return authorizationScopePlaceholder;`,
)();
const projects = [{ id: 'p1', name: 'Alpha' }, { id: 'p2', name: 'Beta' }];
const filled = authorizationEditorHtmlFn('e1', { level: 'developer', scope: 'projects', projectIds: ['p1'] }, projects, 'p1');
const blank = authorizationEditorHtmlFn('e2', { level: 'developer', scope: 'projects', projectIds: [] }, projects);

ok(/authz-scope-field[\s\S]*authz-scope-chip[\s\S]*authz-scope-input[\s\S]*<\/div>/.test(filled),
  'chips and the typing cursor share a single scope field');
ok((filled.match(/<input/g) || []).length === 1, 'the scope field is the only text input in the editor');
ok(/placeholder=""/.test(filled), 'a field that already holds a scope shows no leftover hint');
ok(/placeholder="[^"]*[Pp]roject[^"]*"/.test(blank), 'an empty field invites typing a project name');
ok(authorizationScopePlaceholder(['@organization']) === '' && authorizationScopePlaceholder([]).includes('@organization'),
  'the placeholder is the empty state of the one field, not a permanent hint');
ok(source.includes('input.placeholder = authorizationScopePlaceholder('),
  'the live editor keeps the placeholder in step with the chips');

ok(source.includes('function chooseAuthorizationGrant('), 'task and Avatar flows share one authorization-gap prompt');
ok(source.includes('Ask someone who can grant it') && source.includes('Limit it to my capabilities'),
  'the prompt presents both secure outcomes in plain language');
ok(source.includes("api('/api/authorization/escalation-targets'"),
  'recipient choices come from the server-filtered eligibility endpoint');
ok(source.includes("target: { kind: 'task'") && source.includes("target: { kind: 'avatar'"),
  'both task and Avatar creation can route approval to the target resource');
ok(source.includes('Awaiting a routed approver') && source.includes('request.recipients.includes(signedInUserId)'),
  'only a routed human sees controls for deciding an authorization request');
ok(css.includes('.authorization-gap-card') && css.includes('.authorization-gap-recipient'),
  'the shared decision prompt and recipient picker have dedicated responsive styling');

// Stacked, and styled from inside .authz-editor: the generic `.form-row input`
// rules are more specific than a bare `.authz-scope-input`, so without the
// parent qualifier the task form repaints the field as its own boxed input.
ok(/\.authz-editor\s*\{[^}]*display:\s*grid/.test(css), 'the level sits on its own line above the scope field');
ok(css.includes('.authz-editor .authz-level-select'), 'the level select is styled from inside the editor');
ok(css.includes('.authz-editor .authz-scope-input'), 'the scope input is styled from inside the editor');
ok(/\.authz-scope-field\s*\{[^}]*flex-wrap:\s*wrap/.test(css), 'scope chips wrap inside the field instead of squeezing it');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
