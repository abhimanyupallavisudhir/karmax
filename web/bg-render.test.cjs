// Verifies the transient-UI protections added to app.js:
//  - interactionInFlight(): a background repaint is deferred while a native
//    <select> dropdown is focused or a mouse text-selection is live, so a steady
//    agent event stream can't keep closing the ＋ Filter… menu / clearing a
//    selection under the user.
//  - updateLiveBubble(): the streaming conversation only auto-scrolls when the
//    reader is already parked at the bottom; if they've scrolled up it holds fixed.
// Run: node web/bg-render.test.cjs
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

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

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('FAIL:', msg); } };

// ── interactionInFlight ──────────────────────────────────────────────────────
let ACTIVE = null;
let SELECTION = { isCollapsed: true, rangeCount: 0, anchorNode: null };
let mainPointerDown = false;
global.document = { get activeElement() { return ACTIVE; } };
global.window = { getSelection: () => SELECTION };
eval(extractFn('interactionInFlight'));

const root = { contains: (el) => el === IN || (el && el._in) };
const IN = { tagName: 'SELECT' };          // a <select> that lives inside #main
const OUT = { tagName: 'SELECT' };         // a <select> elsewhere (topbar)

mainPointerDown = true;
ok(interactionInFlight(root) === true, 'a pointer-down in the main view defers replacement');
mainPointerDown = false;

ACTIVE = IN; SELECTION = { isCollapsed: true, rangeCount: 0 };
ok(interactionInFlight(root) === true, 'focused <select> inside root defers the repaint');

ACTIVE = OUT;
ok(interactionInFlight(root) === false, '<select> outside root does not defer');

ACTIVE = { tagName: 'INPUT' };
ok(interactionInFlight(root) === false, 'a focused text input does not defer (its value/caret are preserved instead)');

ACTIVE = null;
SELECTION = { isCollapsed: false, rangeCount: 1, anchorNode: { nodeType: 1, _in: true } };
ok(interactionInFlight(root) === true, 'a live text-selection inside root defers the repaint');

SELECTION = { isCollapsed: false, rangeCount: 1, anchorNode: { nodeType: 3, parentNode: { _in: true } } };
ok(interactionInFlight(root) === true, 'selection anchored on a text node (via parent) also defers');

SELECTION = { isCollapsed: true, rangeCount: 1, anchorNode: { nodeType: 1, _in: true } };
ok(interactionInFlight(root) === false, 'a collapsed selection (just a caret) does not defer');

SELECTION = { isCollapsed: false, rangeCount: 1, anchorNode: { nodeType: 1, _in: false } };
ok(interactionInFlight(root) === false, 'a selection outside root does not defer');

// ── updateLiveBubble: follow the stream only when parked at the bottom ────────
global.esc = (s) => s;
global.S = { liveOutput: { do: { text: 'streaming text' } }, view: { status: 'active' } };
let bubble, thread;
global.document.getElementById = (id) => (id === 'live-bubble' ? bubble : id === 'ck-thread' ? thread : null);
eval(extractFn('updateLiveBubble'));
eval(extractFn('liveOutputFor'));

function makeBubble() {
  return { innerHTML: '', _scrolled: false, classList: { remove() {} }, scrollIntoView() { this._scrolled = true; } };
}
// Reader parked at the bottom (scrollHeight - scrollTop - clientHeight <= 2).
bubble = makeBubble();
thread = { scrollHeight: 1000, scrollTop: 970, clientHeight: 30 };
updateLiveBubble('do');
ok(bubble._scrolled === true, 'at the bottom → the stream keeps the view pinned to the latest text');

// Reader scrolled up reading history — must NOT be yanked down.
bubble = makeBubble();
thread = { scrollHeight: 1000, scrollTop: 100, clientHeight: 300 };
updateLiveBubble('do');
ok(bubble._scrolled === false, 'scrolled up → streaming text does not steal the view');
ok(bubble.innerHTML.includes('streaming text'), 'the bubble content still updates while scrolled up');
bubble = makeBubble();
thread = { scrollHeight: 1000, scrollTop: 680, clientHeight: 300 };
updateLiveBubble('do');
ok(bubble._scrolled === false, 'even a small upward scroll releases the live stream from the bottom');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
