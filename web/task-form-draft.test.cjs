// Regression coverage for saving quick-composer text when the expanded task
// form is closed before the user makes another edit.
// Run: node web/task-form-draft.test.cjs
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

function extractFn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0;
  const body = src.indexOf('{', start);
  for (let i = body; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

eval(extractFn('initialTaskFormSaveSignature'));
const taskForm = extractFn('openTaskForm');

let pass = 0;
let fail = 0;
const ok = (condition, message) => {
  if (condition) pass++;
  else { fail++; console.error('FAIL:', message); }
};

ok(
  initialTaskFormSaveSignature(undefined, 'quick-composer seed') === null,
  'a new expanded form is unsaved even though its initial text was seeded by the quick composer',
);
ok(
  initialTaskFormSaveSignature({ id: 'draft-1' }, 'stored draft state') === 'stored draft state',
  'an existing draft treats its loaded state as saved so open-and-close does not overwrite it',
);
ok(
  taskForm.includes('let lastSaved = initialTaskFormSaveSignature(draft, stateSig(formState()))'),
  'the expanded form applies the new-versus-existing baseline to its close-time draft flush',
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
