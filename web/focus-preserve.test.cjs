// Verifies captureFocus/restoreFocus (in app.js) preserve a mid-typed field's
// value + caret across a renderMain() innerHTML swap. Run: node web/focus-preserve.test.js
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

// Pull the two helper function definitions out of the browser script and eval
// them in this Node context (they only touch the DOM globals we mock below).
function extractFn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0, i = src.indexOf('{', start);
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`unterminated ${name}`);
}

// A minimal element mock supporting the bits the helpers use.
function makeEl(tag, id) {
  return {
    tagName: tag, id, value: '', selectionStart: 0, selectionEnd: 0,
    _focused: false,
    focus() { this._focused = true; ROOT._active = this; },
    setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; },
  };
}

let ROOT;
global.CSS = { escape: (s) => s };
global.window = { CSS: global.CSS };
global.document = { get activeElement() { return ROOT._active; } };

eval(extractFn('captureFocus'));
eval(extractFn('restoreFocus'));

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('FAIL:', msg); } };

// ── Scenario: user typing in #new-task, background refresh re-renders #main ──
const oldInput = makeEl('INPUT', 'new-task');
oldInput.value = 'fix the login b';
oldInput.selectionStart = oldInput.selectionEnd = oldInput.value.length;

ROOT = {
  _active: oldInput,
  contains: (el) => el === oldInput || el === ROOT._newInput,
  querySelector: () => ROOT._newInput,
};
ROOT._active = oldInput;

const st = captureFocus(ROOT);
ok(st && st.id === 'new-task', 'captures focused input');
ok(st.value === 'fix the login b', 'captures in-progress value');

// Simulate innerHTML swap: a brand-new empty input replaces the old one.
const newInput = makeEl('INPUT', 'new-task');
ROOT._newInput = newInput;
ROOT._active = null; // innerHTML swap drops focus

restoreFocus(ROOT, st);
ok(newInput.value === 'fix the login b', 'restores typed value onto fresh input');
ok(newInput._focused === true, 'restores focus');
ok(newInput.selectionStart === 15 && newInput.selectionEnd === 15, 'restores caret position');

// ── Scenario: nothing focused inside main → no snapshot, no crash ──
ROOT._active = null;
ok(captureFocus(ROOT) === null, 'no focused field → null snapshot');
restoreFocus(ROOT, null); // must be a no-op
ok(true, 'restoreFocus(null) is a safe no-op');

// ── Scenario: focus outside root (e.g. #search in topbar) is ignored ──
const outside = makeEl('INPUT', 'search');
ROOT._active = outside; // contains() returns false for it
ok(captureFocus(ROOT) === null, 'focus outside #main is not captured');

// ── Scenario: a SELECT keeps its own re-rendered value (not overwritten) ──
const oldSel = makeEl('SELECT', 'new-wf');
oldSel.value = 'software-dev';
ROOT._active = oldSel;
ROOT.contains = (el) => el === oldSel || el === ROOT._newSel;
const selSt = captureFocus(ROOT);
const newSel = makeEl('SELECT', 'new-wf');
newSel.value = 'software-dev';
ROOT._newSel = newSel;
ROOT.querySelector = () => ROOT._newSel;
restoreFocus(ROOT, selSt);
ok(newSel._focused === true, 'select regains focus');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
