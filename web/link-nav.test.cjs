// Verifies the "open in a new tab" plumbing in app.js: isNewTabClick() classifies
// which clicks the browser should handle natively (so we never hijack a Ctrl/⌘/
// Shift/Alt or non-primary click), and spaNavigate() records the list to return
// to when a task permalink is opened from a non-task page.
// Run: node web/link-nav.test.cjs
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

// A route is a "task page" iff its path has /tasks/<key>; enough for spaNavigate.
global.parseRoute = (p) => { const m = /\/tasks\/([^/]+)/.exec(p || ''); return { taskKey: m ? m[1] : null }; };
const S = global.S = { returnRoute: null };
let lastGo = null;
global.go = (path) => { lastGo = path; return path; };
global.location = { pathname: '/acme/website-redesign', search: '' };

eval(extractFn('currentPath'));
eval(extractFn('isNewTabClick'));
eval(extractFn('spaNavigate'));

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error(`FAIL: ${msg}`); } };
const ev = (o = {}) => Object.assign({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }, o);

// ── isNewTabClick: a plain primary click is ours; everything else is the browser's
ok(!isNewTabClick(ev()), 'plain left-click is handled in place');
ok(isNewTabClick(ev({ ctrlKey: true })), 'Ctrl-click → browser (new tab)');
ok(isNewTabClick(ev({ metaKey: true })), '⌘-click → browser (new tab)');
ok(isNewTabClick(ev({ shiftKey: true })), 'Shift-click → browser (new window)');
ok(isNewTabClick(ev({ altKey: true })), 'Alt-click → browser');
ok(isNewTabClick(ev({ button: 1 })), 'middle-click → browser (new tab)');
ok(isNewTabClick(ev({ button: 2 })), 'right-click → browser (context menu)');

// ── spaNavigate: remember the origin list only when opening a task from a non-task page
S.returnRoute = null; location.pathname = '/acme/website-redesign';
spaNavigate('/acme/website-redesign/tasks/42');
ok(lastGo === '/acme/website-redesign/tasks/42', 'spaNavigate routes via go()');
ok(S.returnRoute === '/acme/website-redesign', 'opening a task from a list remembers the list');

S.returnRoute = null; location.pathname = '/acme/website-redesign/tasks/42';
spaNavigate('/acme/website-redesign/tasks/43');
ok(S.returnRoute === null, 'walking task→task does not overwrite the return route');

S.returnRoute = null; location.pathname = '/acme/website-redesign';
spaNavigate('/acme/globex');
ok(S.returnRoute === null, 'navigating list→list (non-task) sets no return route');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
