// Memory-only conversation math preferences and asynchronous typesetting.
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
let preference = true, rerenders = 0, typesets = 0, finishLoading;
const context = vm.createContext({
  S: {},
  mathjaxEnabled: () => preference,
  markdownEnabled: () => true,
  renderTaskPage: () => rerenders++,
  renderMarkdown: (text, options) => options.math ? '<math>' + text + '</math>' : text,
  ensureMathJax: () => new Promise((resolve) => { finishLoading = resolve; }),
  window: { MathJax: { typesetPromise: async () => { typesets++; } } },
});
for (const name of ['conversationMathEnabled', 'toggleConversationMath', 'renderMessageBody', 'typesetMath', 'wireExplainMessages']) {
  vm.runInContext(extractFn(name), context);
}
const a = { taskId: 'a' }, b = { taskId: 'b' };
const enabled = (v, role = 'do') => context.conversationMathEnabled(v, role);
assert.equal(enabled(a), true);
preference = false;
assert.equal(enabled(a), false, 'untouched conversation follows changed preference');
context.toggleConversationMath(a, 'do');
assert.equal(enabled(a), true, 'can enable over an off preference');
assert.equal(enabled(a, 'merge'), false, 'other agents remain independent');
assert.equal(enabled(b), false, 'other tasks remain independent');
assert.equal(context.renderMessageBody('$x$', enabled(a)), '<math>$x$</math>');
assert.equal(context.renderMessageBody('$x$'), '$x$', 'non-conversation rendering follows profile');
preference = true;
context.toggleConversationMath(a, 'do');
assert.equal(enabled(a), false, 'can disable over an on preference');
assert.equal(context.renderMessageBody('$x$', enabled(a)), '$x$');
assert.equal(preference, true, 'toggle never changes the profile preference');
assert.equal(rerenders, 2, 'each click refreshes the conversation');
context.S = {};
assert.equal(enabled(a), true, 'fresh page state forgets the override');

let click, focused = false, bindings = 0;
const control = { addEventListener: (_, handler) => { bindings++; click = handler; }, focus: () => { focused = true; } };
const toolbar = { dataset: { role: 'merge', sourceKey: 'message:1' }, querySelector: (selector) => selector === '.conversation-math' ? control : null };
context.$ = () => ({ querySelectorAll: () => [toolbar] });
context.wireExplainMessages(a);
context.wireExplainMessages({ ...a });
assert.equal(bindings, 1, 'retained toolbars are not wired repeatedly');
click();
assert.equal(enabled(a, 'merge'), false, 'button click overrides its own conversation');
assert.equal(enabled(a), true, 'button click leaves other conversations untouched');
assert.equal(focused, true, 'button retains keyboard focus after repaint');

(async () => {
  const math = [{ dataset: {} }];
  const scope = { querySelectorAll: () => math, id: 'ck-thread', dataset: { taskId: 'a', role: 'do' }, isConnected: true, querySelector: () => true };
  context.typesetMath(scope);
  context.toggleConversationMath(a, 'do');
  finishLoading(true);
  await Promise.resolve();
  assert.equal(typesets, 0, 'loading MathJax cannot typeset after switching off');
  context.toggleConversationMath(a, 'do');
  context.typesetMath(scope);
  scope.isConnected = false;
  finishLoading(true);
  await Promise.resolve();
  assert.equal(typesets, 0, 'loading MathJax cannot typeset a replaced thread');
  scope.isConnected = true;
  preference = false;
  context.typesetMath(scope);
  finishLoading(true);
  await Promise.resolve();
  assert.equal(typesets, 1, 'conversation override enables typesetting over off profile');
  context.typesetMath(scope);
  finishLoading(true);
  await Promise.resolve();
  assert.equal(typesets, 1, 'retained math is not typeset again on a background refresh');
  math.push({ dataset: {} });
  context.typesetMath(scope);
  finishLoading(true);
  await Promise.resolve();
  assert.equal(typesets, 2, 'new messages still get typeset');
  console.log('Conversation math scope, rendering, toggling and async loading checks passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
