// The conversation TeX button toggles the global math preference; typesetting
// stays asynchronous and never runs after the preference is switched off.
// Run: node web/conversation-math.test.cjs
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

// Brace-count from the body's opening `{` (skips any `{}` in the parameter list,
// e.g. `opts = {}`), so functions with default-object params extract cleanly.
function extractFn(name) {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`${name} not found`);
  const bodyStart = src.indexOf(') {', at);
  let depth = 0;
  for (let i = src.indexOf('{', bodyStart); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

const assert = require('node:assert/strict');
const vm = require('node:vm');
const store = new Map();
let rerenders = 0, typesets = 0, finishLoading;
const context = vm.createContext({
  S: { taskTab: 'checkin' },
  localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
  markdownEnabled: () => true,
  renderTaskPage: () => rerenders++,
  renderMarkdown: (text, options) => options.math ? '<math>' + text + '</math>' : text,
  ensureMathJax: () => new Promise((resolve) => { finishLoading = resolve; }),
  window: { MathJax: { typesetPromise: async () => { typesets++; } } },
});
vm.runInContext(src.match(/^function renderFlag\([\s\S]*?^}\n/m)[0], context);
vm.runInContext(src.match(/^const mathjaxEnabled = .*$/m)[0].replace('const ', 'globalThis.'), context);
for (const name of ['setMathjaxEnabled', 'renderMessageBody', 'typesetMath', 'wireExplainMessages']) {
  vm.runInContext(extractFn(name), context);
}
assert.equal(src.includes('conversationMath'), false, 'no per-conversation math override remains');
assert.equal(context.mathjaxEnabled(), true, 'math is on by default');
context.setMathjaxEnabled(false);
assert.equal(store.get('karmax-mathjax'), '0', 'turning math off persists the global preference');
assert.equal(context.mathjaxEnabled(), false);
assert.equal(context.renderMessageBody('$x$'), '$x$');
context.setMathjaxEnabled(true);
assert.equal(store.get('karmax-mathjax'), '1');
assert.equal(context.renderMessageBody('$x$'), '<math>$x$</math>');
assert.equal(rerenders, 2, 'each change refreshes the open conversation');

let click, focused = false, bindings = 0;
const control = { addEventListener: (_, handler) => { bindings++; click = handler; }, focus: () => { focused = true; } };
const toolbar = { dataset: { role: 'merge', sourceKey: 'message:1' }, querySelector: (selector) => selector === '.conversation-math' ? control : null };
context.$ = () => ({ querySelectorAll: () => [toolbar] });
const a = { taskId: 'a' };
context.wireExplainMessages(a);
context.wireExplainMessages({ ...a });
assert.equal(bindings, 1, 'retained toolbars are not wired repeatedly');
click();
assert.equal(store.get('karmax-mathjax'), '0', 'button click toggles the global preference');
click();
assert.equal(store.get('karmax-mathjax'), '1', 'a second click turns it back on');
assert.equal(focused, true, 'button retains keyboard focus after repaint');

(async () => {
  const math = [{ dataset: {} }];
  const scope = { querySelectorAll: () => math, id: 'ck-thread', dataset: { taskId: 'a', role: 'do' }, isConnected: true, querySelector: () => true };
  context.typesetMath(scope);
  context.setMathjaxEnabled(false);
  finishLoading(true);
  await Promise.resolve();
  assert.equal(typesets, 0, 'loading MathJax cannot typeset after switching off');
  context.setMathjaxEnabled(true);
  context.typesetMath(scope);
  scope.isConnected = false;
  finishLoading(true);
  await Promise.resolve();
  assert.equal(typesets, 0, 'loading MathJax cannot typeset a replaced thread');
  scope.isConnected = true;
  context.typesetMath(scope);
  finishLoading(true);
  await Promise.resolve();
  assert.equal(typesets, 1, 'math typesets when the preference is on');
  context.typesetMath(scope);
  finishLoading(true);
  await Promise.resolve();
  assert.equal(typesets, 1, 'retained math is not typeset again on a background refresh');
  math.push({ dataset: {} });
  context.typesetMath(scope);
  finishLoading(true);
  await Promise.resolve();
  assert.equal(typesets, 2, 'new messages still get typeset');
  console.log('Conversation math preference, rendering, toggling and async loading checks passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
