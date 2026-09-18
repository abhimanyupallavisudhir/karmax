const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
function fn(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const end = src.indexOf('\n}', start) + 2;
  return src.slice(start, end);
}
let keydown;
const attrs = {};
const button = { setAttribute: (k, v) => attrs[k] = v, focus: () => button.focused = true };
const pane = { classList: { toggle: (name, on) => pane.fullscreen = on } };
const roots = { childElementCount: 0 };
let overlayClosed = false;
const context = vm.createContext({
  S: {}, ICON: { expand: 'expand', collapse: 'collapse' },
  $: selector => selector === '#conversation-fullscreen' ? button : selector === '.ck-pane' ? pane : selector === '.ck-fullscreen' ? (pane.fullscreen ? pane : null) : roots,
  document: { addEventListener: (type, handler) => keydown = handler },
  resetChord() {}, focusedEnterAction: () => null, closeTopOverlay() { overlayClosed = true; },
});
vm.runInContext(fn('conversationFullscreenButton') + '\n' + fn('setConversationFullscreen') + '\n' + fn('bindKeys'), context);
assert.match(context.conversationFullscreenButton(), /aria-label="Full screen"/);
context.setConversationFullscreen(true);
assert.equal(pane.fullscreen, true);
assert.equal(attrs['aria-label'], 'Exit full screen');
assert.equal(attrs['aria-pressed'], 'true');
assert.match(context.conversationFullscreenButton(), /Exit full screen/);
context.bindKeys();
let prevented = false;
keydown({ key: 'Escape', target: { matches: () => true, blur() { throw Error('Esc should exit before blurring'); } }, preventDefault() { prevented = true; } });
assert.equal(prevented, true);
assert.equal(pane.fullscreen, false);
assert.equal(context.S.conversationFullscreen, false);
assert.equal(button.focused, true);
assert.equal(overlayClosed, false, 'Esc leaves the task open');
context.setConversationFullscreen(true);
roots.childElementCount = 1;
keydown({ key: 'Escape', target: { matches: () => false } });
assert.equal(overlayClosed, true, 'Nested overlay handles Esc first');
assert.equal(pane.fullscreen, true);
roots.childElementCount = 0;
keydown({ key: 'Escape', defaultPrevented: true });
assert.equal(pane.fullscreen, true, 'Component-owned Escape is respected');
context.setConversationFullscreen(true);
context.setConversationFullscreen(false);
assert.equal(attrs['aria-label'], 'Full screen');
assert.match(src, /ck-pane\$\{S.conversationFullscreen/);
console.log('Conversation full-screen toggle and Escape tests passed');
