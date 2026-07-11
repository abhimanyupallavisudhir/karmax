// Verifies shouldFocusDrawerBody (in app.js) decides correctly when renderDrawer
// should hand keyboard focus to the scrollable drawer body — so a freshly opened
// drawer is scrollable with PgUp/PgDn/Home/End/arrows, without ever stealing focus
// from a field the user is typing in or from an overlay stacked above the drawer.
// Run: node web/drawer-focus.test.cjs
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

const BODY = { tag: 'body' };
global.document = { body: BODY };

eval(extractFn('shouldFocusDrawerBody'));

// A drawer root that "contains" only the elements we register on it.
const root = { _kids: new Set(), contains(el) { return this._kids.has(el); } };
function inDrawer(props) { const el = { matches: (sel) => (props.matchSel ? sel.split(',').some((s) => props.matchSel.includes(s.trim())) : false), classList: { contains: (c) => (props.cls || []).includes(c) }, isContentEditable: !!props.editable }; root._kids.add(el); return el; }

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('FAIL:', msg); } };

// Fresh open: focus sits on <body> (or nowhere) → take focus so scroll keys work.
ok(shouldFocusDrawerBody(root, BODY, false) === true, 'fresh open (body focused) → focus drawer body');
ok(shouldFocusDrawerBody(root, null, false) === true, 'fresh open (nothing focused) → focus drawer body');

// The drawer body already holds focus across a re-render → keep it.
const bodyEl = inDrawer({ matchSel: '' });
ok(shouldFocusDrawerBody(root, bodyEl, false) === true, 're-render with body focused → keep focus');

// Never steal from a field the user is typing in.
ok(shouldFocusDrawerBody(root, inDrawer({ matchSel: 'textarea' }), false) === false, 'composer textarea focused → do not steal');
ok(shouldFocusDrawerBody(root, inDrawer({ matchSel: 'input' }), false) === false, 'param input focused → do not steal');
ok(shouldFocusDrawerBody(root, inDrawer({ matchSel: 'select' }), false) === false, 'select focused → do not steal');
ok(shouldFocusDrawerBody(root, inDrawer({ editable: true }), false) === false, 'contentEditable focused → do not steal');
ok(shouldFocusDrawerBody(root, inDrawer({ cls: ['term-screen'] }), false) === false, 'check-in terminal focused → do not steal');

// An overlay/modal stacked above the drawer owns the keyboard.
ok(shouldFocusDrawerBody(root, BODY, true) === false, 'overlay open → do not focus drawer body');

// Focus living outside the drawer (e.g. an overlay input) must be left alone.
const outside = { matches: () => false, classList: { contains: () => false } };
ok(shouldFocusDrawerBody(root, outside, false) === false, 'focus outside the drawer → leave it');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
