// Verifies captureFocus/restoreFocus (in app.js) preserve a mid-typed field's
// value + caret across a renderMain() innerHTML swap, and that the follow-up
// variants keep the task page's send-message box focused/in-view across a
// renderTaskPage() re-render (instead of jumping away).
// Run: node web/focus-preserve.test.cjs
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
eval(extractFn('captureFollowupFocus'));
eval(extractFn('restoreFollowupFocus'));

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

// ── Follow-up box: refresh (after send) must keep the box focused, not jump to top ──
// A textarea keyed by agent role, not an id, so captureFocus ignores it and the
// dedicated follow-up helpers must carry focus/caret across the page re-render.
function makeFollowup(role, value, scrollTop = 0) {
  const ta = {
    tagName: 'TEXTAREA', value, disabled: false, selectionStart: value.length, selectionEnd: value.length,
    scrollTop, _focused: false, _preventScroll: null,
    classList: { contains: (c) => c === 'followup-input' },
    closest: (sel) => (sel === '.followup-box' ? ta._box : null),
    focus(opts) { this._focused = true; this._preventScroll = !!(opts && opts.preventScroll); ROOT._active = this; },
    setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; },
    querySelector: (sel) => (sel === '.followup-input' ? ta : null),
  };
  ta._box = { dataset: { role }, querySelector: ta.querySelector };
  return ta;
}

// Scenario A: Ctrl-Enter send leaves focus in the (now-empty) box; refresh re-focuses it.
const sentBox = makeFollowup('do', ''); // value cleared on send
ROOT = { _active: sentBox, contains: (el) => el === sentBox || el === ROOT._new,
  querySelector: () => ROOT._new._box };
const fuSt = captureFollowupFocus(ROOT);
ok(fuSt && fuSt.role === 'do', 'captures focused follow-up box by role');

const freshBox = makeFollowup('do', '');
ROOT._new = freshBox;
ROOT._active = null; // innerHTML swap dropped focus
restoreFollowupFocus(ROOT, fuSt);
ok(freshBox._focused === true, 'refresh re-focuses the follow-up box (no jump to top)');

// Scenario B: background refresh mid-typing carries the half-typed value over.
const typing = makeFollowup('merge', 'please also update the ');
ROOT = { _active: typing, contains: (el) => el === typing || el === ROOT._new,
  querySelector: () => ROOT._new._box };
const typSt = captureFollowupFocus(ROOT);
const emptyFresh = makeFollowup('merge', '');
ROOT._new = emptyFresh;
ROOT._active = null;
restoreFollowupFocus(ROOT, typSt);
ok(emptyFresh.value === 'please also update the ', 'carries half-typed follow-up across refresh');
ok(emptyFresh._focused === true, 'and keeps the box focused');

// Scenario C: nothing follow-up focused → null snapshot, safe no-op restore.
ROOT = { _active: null, contains: () => false };
ok(captureFollowupFocus(ROOT) === null, 'no follow-up focus → null snapshot');
restoreFollowupFocus(ROOT, null);
ok(true, 'restoreFollowupFocus(null) is a safe no-op');

// Scenario D: a long draft scrolled inside the box — the box's own scroll offset
// and preventScroll must survive the re-render so it doesn't jump to the top.
const scrolled = makeFollowup('do', 'line1\nline2\nline3\nline4\nline5', 72);
ROOT = { _active: scrolled, contains: (el) => el === scrolled || el === ROOT._new,
  querySelector: () => ROOT._new._box };
const scSt = captureFollowupFocus(ROOT);
ok(scSt.scrollTop === 72, 'captures the box internal scroll offset');
const freshScrolled = makeFollowup('do', 'line1\nline2\nline3\nline4\nline5', 0);
ROOT._new = freshScrolled;
ROOT._active = null;
restoreFollowupFocus(ROOT, scSt);
ok(freshScrolled.scrollTop === 72, 'restores the box internal scroll (no jump to top)');
ok(freshScrolled._preventScroll === true, 'focuses with preventScroll so the thread does not scroll');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
