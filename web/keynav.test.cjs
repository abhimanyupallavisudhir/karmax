// Verifies the pure pieces of the keyboard/command layer (in app.js):
// keybinding parsing, keystroke matching, chord candidate selection, keybinding
// display formatting, and the palette's fuzzy matcher.
// Run: node web/keynav.test.cjs
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
function extractConst(name) {
  const start = src.indexOf(`const ${name} = `);
  if (start < 0) throw new Error(`${name} not found`);
  const end = src.indexOf(';\n', start);
  return src.slice(start, end + 1);
}

// Node ≥21 ships a read-only globalThis.navigator; defineProperty to mock it.
const setPlatform = (platform) => Object.defineProperty(globalThis, 'navigator', { value: { platform }, configurable: true });
setPlatform('Linux x86_64'); // fmtKeys: non-mac glyphs

// `const` inside a direct eval doesn't leak to this scope (functions do), so
// re-target the lookup table onto `global` before evaluating the functions.
eval(extractConst('KEY_NAMES').replace('const KEY_NAMES =', 'global.KEY_NAMES ='));
eval(extractFn('parseKeybinding'));
eval(extractFn('stepMatches'));
eval(extractFn('chordCandidates'));
eval(extractFn('isBareModifier'));
eval(extractFn('focusedEnterAction'));
eval(extractFn('fmtKeys'));
eval(extractFn('fuzzyScore'));
eval(extractFn('adjacentCheckinPane'));
eval(extractConst('firstLine').replace('const firstLine =', 'global.firstLine ='));
eval(extractConst('QUICK_TASK_WORKFLOW').replace('const QUICK_TASK_WORKFLOW =', 'global.QUICK_TASK_WORKFLOW ='));
eval(extractFn('quickTaskSubmitMode'));
eval(extractFn('quickTaskPayload'));
eval(extractFn('initialTaskFormSavedSignature'));
eval(extractFn('taskFormKeyAction'));

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('FAIL:', msg); } };
const ev = (key, mods = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

// ── Quick-add guidance ──
ok(
  src.includes('placeholder="New Task · ↵ for full task form · Ctrl+↵ to send"'),
  'quick-add placeholder explains only its primary submit shortcuts',
);
ok(!src.includes('Ctrl+V to paste image') && !src.includes(' · (n)"'), 'quick-add placeholder omits paste and bare-key hints');
ok(
  src.includes('class="quick-task-field"')
    && src.includes('class="btn soft icon-only attach-composer quick-task-attach"'),
  'quick-add attachment picker is a soft button inside the task field',
);

// The Activity feed is an internal debugging page. Its direct route remains
// usable, but users must not discover it through the tab bar, command palette,
// keyboard help, or a g+a shortcut.
for (const effective of [false, true]) {
  const tabs = require('node:vm').runInNewContext(`${extractConst('tabs')} tabs`, {
    S: { avatarAvailability: { effective }, avatars: [] },
  });
  ok(!tabs.includes('activity'), `project navigation omits Activity with Avatars ${effective ? 'enabled' : 'disabled'}`);
  ok(tabs.includes('tasks') && tabs.includes('settings'), 'project navigation retains tasks and settings');
}
ok(!src.includes("id: 'nav.activity'"), 'Activity has no user-facing navigation command');

// ── parseKeybinding ──
ok(JSON.stringify(parseKeybinding('n')) === JSON.stringify([{ key: 'n' }]), 'single key');
ok(JSON.stringify(parseKeybinding('g t')) === JSON.stringify([{ key: 'g' }, { key: 't' }]), 'two-step chord');
ok(JSON.stringify(parseKeybinding('meta+k')) === JSON.stringify([{ key: 'k', meta: true }]), 'meta modifier');
ok(JSON.stringify(parseKeybinding('meta+shift+F')) === JSON.stringify([{ key: 'F', meta: true, shift: true }]), 'a three-key modifier chord');
ok(JSON.stringify(parseKeybinding('cmd+K')) === JSON.stringify([{ key: 'K', meta: true }]), 'cmd alias + case preserved');
ok(JSON.stringify(parseKeybinding('Escape')) === JSON.stringify([{ key: 'escape' }]), 'named key normalizes');
ok(JSON.stringify(parseKeybinding('ArrowDown')) === JSON.stringify([{ key: 'arrowdown' }]), 'arrow key normalizes');
ok(JSON.stringify(parseKeybinding('?')) === JSON.stringify([{ key: '?' }]), 'shifted punctuation is its own key');
ok(JSON.stringify(parseKeybinding('[')) === JSON.stringify([{ key: '[' }]), 'bracket binds as a plain key (task-page tab cycling)');
ok(JSON.stringify(parseKeybinding('}')) === JSON.stringify([{ key: '}' }]), 'brace binds as a plain key (Check-in pane cycling)');
ok(parseKeybinding('').length === 0, 'empty binding → no steps');

// ── stepMatches ──
ok(stepMatches({ key: 'c' }, ev('c')), 'plain key matches');
ok(!stepMatches({ key: 'c' }, ev('c', { ctrlKey: true })), 'Ctrl+C must NOT match a plain c (copy stays copy)');
ok(!stepMatches({ key: 'c' }, ev('c', { metaKey: true })), 'Cmd+C must NOT match a plain c');
ok(stepMatches(parseKeybinding(']')[0], ev(']')), 'next-tab ] matches its keystroke');
ok(!stepMatches(parseKeybinding('[')[0], ev('[', { ctrlKey: true })), 'Ctrl+[ must NOT match a plain [');
ok(!stepMatches({ key: 'c' }, ev('C')), 'case-sensitive: C (shift) is not c');
ok(stepMatches({ key: 'J' }, ev('J', { shiftKey: true })), 'uppercase binding matches shifted key');
ok(stepMatches({ key: 'k', meta: true }, ev('k', { metaKey: true })), 'meta+k matches Cmd');
ok(stepMatches({ key: 'k', meta: true }, ev('k', { ctrlKey: true })), 'meta+k also matches Ctrl (Linux/Windows)');
ok(stepMatches(parseKeybinding('meta+shift+F')[0], ev('F', { ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+F matches meta+shift+F');
ok(!stepMatches(parseKeybinding('meta+shift+F')[0], ev('f', { ctrlKey: true })), 'Ctrl+F remains the browser find shortcut');
ok(!stepMatches({ key: 'k', meta: true }, ev('k')), 'meta+k needs the modifier');
ok(stepMatches({ key: 'escape' }, ev('Escape')), 'named keys match case-insensitively');
ok(!stepMatches({ key: 'j' }, ev('j', { altKey: true })), 'alt held blocks a bare binding');

// ── chordCandidates (the dispatcher's core) ──
const cmds = [
  { id: 'nav.newTask', keys: parseKeybinding('n') },
  { id: 'nav.tasks', keys: parseKeybinding('g t') },
  { id: 'nav.queue', keys: parseKeybinding('g q') },
  { id: 'nav.global', keys: parseKeybinding('g g') },
  { id: 'nav.notifications', keys: parseKeybinding('g N') },
  { id: 'pal', keys: parseKeybinding('meta+k') },
];
ok(chordCandidates(cmds, [], ev('n')).map((c) => c.id).join() === 'nav.newTask', 'exact single-key match');
ok(chordCandidates(cmds, [], ev('g')).length === 4, "'g' opens a 4-way chord prefix");
ok(chordCandidates(cmds, [ev('g')], ev('t')).map((c) => c.id).join() === 'nav.tasks', 'g then t resolves');
ok(chordCandidates(cmds, [ev('g')], ev('g')).map((c) => c.id).join() === 'nav.global', 'g then g resolves (prefix reuse)');
ok(chordCandidates(cmds, [ev('g')], ev('N', { shiftKey: true })).map((c) => c.id).join() === 'nav.notifications', 'g then uppercase N opens notifications');
ok(!chordCandidates(cmds, [ev('g')], ev('n')).some((c) => c.id === 'nav.notifications'), 'lowercase g n does not open notifications');
ok(chordCandidates(cmds, [ev('g')], ev('z')).length === 0, 'g then unknown → no candidates');
ok(chordCandidates(cmds, [], ev('k', { ctrlKey: true })).map((c) => c.id).join() === 'pal', 'Ctrl+K finds meta+k');
ok(chordCandidates(cmds, [], ev('t')).length === 0, "bare 't' is not a command (only after 'g')");

// ── Enter follows focus before global list selection ──
const focused = (kind) => ({ closest: (selector) => {
  if (kind === 'button') return selector.includes('button') ? {} : null;
  if (kind === 'chip') return selector.includes('[tabindex="0"]') ? {} : null;
  if (kind === 'role') return selector.includes('[role="button"]') ? {} : null;
  return null;
} });
ok(focusedEnterAction(ev('Enter'), focused('button')) === 'native', 'Enter leaves a focused native button to browser activation');
ok(focusedEnterAction(ev('Enter'), focused('chip')) === 'click', 'Enter clicks a focused tabindex control before the list cursor');
ok(focusedEnterAction(ev('Enter'), focused('role')) === 'click', 'Enter clicks a focused custom role=button control');
ok(focusedEnterAction(ev('Enter', { ctrlKey: true }), focused('chip')) === null, 'Ctrl+Enter remains available to global commands when a control is focused');
ok(focusedEnterAction(ev('Enter', { metaKey: true }), focused('button')) === null, 'Cmd+Enter remains available to global commands when a native button is focused');
ok(focusedEnterAction(ev('x'), focused('chip')) === null, 'non-Enter keys do not activate the focused control');
ok(src.includes('if (e.defaultPrevented || e.isComposing) return;'), 'component-level Enter handlers are not activated a second time by the document dispatcher');
ok(src.indexOf("const focusedAction = focusedEnterAction(e, t)") < src.indexOf('if (dispatchKey(e)) return;', src.indexOf('function bindKeys()')), 'focused Enter activation is resolved before global key dispatch');
ok(src.indexOf("const focusedAction = focusedEnterAction(e, t)") < src.indexOf('if (overlayOpen)', src.indexOf('function bindKeys()')), 'focused custom controls also activate inside overlays');
ok(src.includes("id: 'list.quickAdd'") && src.includes("keybinding: 'meta+Enter'") && src.includes("run: () => $('#add-task')?.click()"), 'Ctrl/Cmd+Enter clicks quick-add from anywhere on the task list');

// Exercise the actual document handler: a focused row must activate its anchor,
// whereas a draft or a nested custom control owns a direct click. Native key
// events, focus, routing and rendering are covered by the Chromium companion:
// node scripts/test-task-list-keyboard.cjs
eval(extractFn('openListRow'));
let keydown;
new Function('document', '$', 'focusedEnterAction', 'openListRow',
  `${extractFn('bindKeys')}\nbindKeys();`)(
  { addEventListener: (_type, handler) => { keydown = handler; } },
  () => ({ childElementCount: 0 }), focusedEnterAction, openListRow,
);
for (const kind of ['task', 'queue', 'draft', 'nested']) {
  const clicks = [];
  const control = {
    matches: () => kind !== 'nested',
    querySelector: () => ['task', 'queue'].includes(kind) ? { click: () => clicks.push('link') } : null,
    click: () => clicks.push('control'),
  };
  const event = {
    ...ev('Enter'),
    target: {
      matches: () => false,
      closest: (selector) => selector.includes('[tabindex="0"]') ? control : null,
    },
    preventDefault() { this.defaultPrevented = true; },
  };
  keydown(event);
  ok(clicks.join() === (['task', 'queue'].includes(kind) ? 'link' : 'control'),
    `focused ${kind} Enter activates its intended target exactly once`);
  ok(event.defaultPrevented, `focused ${kind} Enter prevents a second default action`);
}

// ── shifted chords survive the Shift keydown (g P / g W / g S) ──
// The dispatcher skips bare-modifier keydowns so pressing Shift for the second
// step of a shifted chord doesn't reset the pending prefix. Model `g` → `Shift`
// → `P`: the Shift event is ignored, so the buffer still holds `g` when `P`/`S`
// lands. (Uses a fresh command whose second step needs Shift.)
ok(isBareModifier('Shift') && isBareModifier('Control') && isBareModifier('Alt') && isBareModifier('Meta'), 'the four bare modifiers are recognized');
ok(!isBareModifier('g') && !isBareModifier('S'), 'ordinary keys are not bare modifiers');
const shiftedCmds = [{ id: 'nav.global', keys: parseKeybinding('g S') }];
ok(isBareModifier('Shift'), 'Shift keydown between g and S is skipped, so the g prefix survives');
ok(chordCandidates(shiftedCmds, [ev('g')], ev('S', { shiftKey: true })).map((c) => c.id).join() === 'nav.global', 'g then Shift+S resolves once the Shift event is ignored');

// ── fmtKeys ──
ok(fmtKeys('meta+k') === 'Ctrl+k', 'meta renders as Ctrl+ on non-mac');
ok(fmtKeys('meta+shift+F') === 'Ctrl+⇧F', 'a three-key chord renders in full');
ok(fmtKeys('g t') === 'g t', 'chords keep their spacing');
ok(fmtKeys('Escape') === 'Esc' && fmtKeys('ArrowDown') === '↓', 'named keys get glyphs');
setPlatform('MacIntel');
ok(fmtKeys('meta+k') === '⌘k', 'meta renders as ⌘ on mac');

// ── fuzzyScore ──
ok(fuzzyScore('', 'anything') === 0, 'empty query matches everything neutrally');
ok(fuzzyScore('xyz', 'Confirm task') === -1, 'non-subsequence → -1');
ok(fuzzyScore('ct', 'Confirm task') >= 0, 'subsequence matches');
ok(fuzzyScore('conf', 'Confirm task') > fuzzyScore('cnf', 'Confirm task'), 'consecutive runs beat scattered letters');
ok(fuzzyScore('task', 'Confirm task') > 0, 'word-boundary bonus applies');
ok(fuzzyScore('gq', 'Go to queues') >= 0, 'initials-style query matches');

// ── Check-in sidebar cycling ──
const panes = ['do', 'merge', 'terminal'];
ok(adjacentCheckinPane(panes, 'do', 1) === 'merge', 'Check-in moves to the next pane');
ok(adjacentCheckinPane(panes, 'terminal', 1) === 'do', 'Check-in next wraps to the first pane');
ok(adjacentCheckinPane(panes, 'do', -1) === 'terminal', 'Check-in previous wraps to the terminal');

// ── Quick-add submission modes ──
ok(quickTaskSubmitMode(ev('Enter')) === 'form', 'Enter opens the full task form');
ok(quickTaskSubmitMode(ev('Enter', { metaKey: true })) === 'add', 'Cmd/Ctrl+Enter starts the task');
ok(quickTaskSubmitMode(ev('Enter', { ctrlKey: true })) === 'add', 'Ctrl+Enter starts the task');
ok(quickTaskSubmitMode(ev('Enter', { altKey: true })) === 'draft', 'Alt+Enter saves a draft');
ok(quickTaskSubmitMode(ev('x', { altKey: true })) === null, 'non-Enter keys do not submit the quick task');
ok(!src.includes('id="new-wf"'), 'quick-add does not show a workflow selector');
const sent = quickTaskPayload('run it', [], false);
const draft = quickTaskPayload('save it', ['image-1'], true);
ok(sent.quick === true && sent.workflow === 'software-dev' && sent.draft === undefined, 'quick send starts immediately with the software-dev workflow');
ok(draft.quick === true && draft.draft === true && draft.images[0] === 'image-1', 'quick draft uses the same payload plus draft=true');

// The text carried by Enter into the full form has never been persisted. Closing
// that form immediately must therefore see a dirty state and create a draft.
ok(extractFn('openTaskForm').includes('initialTaskFormSavedSignature(draft, seedText, stateSig(formState()))'),
  'the expanded form uses the carried-text-aware saved baseline');
const openTaskFormSource = extractFn('openTaskForm');
ok(openTaskFormSource.indexOf('root.innerHTML = taskFormLoadingPage') < openTaskFormSource.indexOf('await Promise.all'),
  'the expanded form acknowledges the keypress before awaiting server hydration');
ok(initialTaskFormSavedSignature(undefined, 'carried quick text', 'seeded-state') === null,
  'quick text starts the expanded form with an unsaved signature');
ok(initialTaskFormSavedSignature(undefined, '', 'empty-state') === 'empty-state',
  'opening an empty expanded form does not make it dirty');
ok(initialTaskFormSavedSignature({ id: 'draft-1' }, 'ignored seed', 'stored-state') === 'stored-state',
  'opening an existing draft keeps its loaded state as the saved baseline');

// Editors such as priority/tags replace their focused node after a change. The
// expanded form shortcut must therefore be page-scoped, not depend on the
// keydown bubbling through #tf-page from the formerly focused control.
ok(taskFormKeyAction(ev('Enter', { ctrlKey: true }), false) === 'submit',
  'Ctrl+Enter submits the expanded form regardless of which form control last had focus');
ok(taskFormKeyAction(ev('Enter', { metaKey: true }), false) === 'submit',
  'Cmd+Enter submits the expanded form regardless of focus');
ok(taskFormKeyAction(ev('Escape'), false) === 'close',
  'Escape closes the expanded form when no secondary modal is open');
ok(taskFormKeyAction(ev('Enter', { ctrlKey: true }), true) === null && taskFormKeyAction(ev('Escape'), true) === null,
  'secondary modals retain ownership of Ctrl+Enter and Escape');
ok(openTaskFormSource.includes("document.addEventListener('keydown', taskFormKeydown, { capture: true, signal: formKeyController.signal })"),
  'expanded-form shortcuts are captured at the document boundary when focus falls back to body');
ok(openTaskFormSource.includes("document.querySelector('body > .modal-overlay')"),
  'body-level decision dialogs retain keyboard ownership above the expanded form');
ok(openTaskFormSource.includes('activeTaskFormKeyController?.abort()') && openTaskFormSource.includes('formKeyController.abort()'),
  'the expanded-form document listener is removed when the form is replaced or dismissed');
ok(openTaskFormSource.includes("activeFormToken !== formToken || !root.querySelector('#tf-page')"),
  'a detached form cannot retain a live document-level submit shortcut');

// Exercise attempt chords through the real command registry and key dispatcher.
global.S = { selected: 'one', view: {}, tab: 'tasks' };
global.HOST_COMMANDS = [];
global.inRail = () => false;
global.openCursorRow = global.archiveCursorRow = () => {};
let newAttempts = 0, taskMoves = 0, attemptKeydown;
global.openAdjacentTask = () => taskMoves++;
const addAttempt = { disabled: false, click: () => newAttempts++ };
let links = ['one', 'two', 'three'].map((id) => ({
  dataset: { attemptSelect: id },
  click: () => { S.selected = id; },
}));
let overlayCount = 0;
global.$ = (selector) => {
  if (selector === '#overlay-root' || selector === '#modal-root') return { childElementCount: overlayCount };
  if (selector === '#add-attempt:not(:disabled)') return addAttempt.disabled ? null : addAttempt;
  return null;
};
global.document = {
  querySelectorAll: (selector) => selector === '[data-attempt-select]' ? links : [],
  addEventListener: (name, handler) => { attemptKeydown = handler; },
};
global.CHORD = { pending: [], timer: null };
for (const name of ['cycleAttempt', 'allCommands', 'resetChord', 'dispatchKey', 'bindKeys']) eval(extractFn(name));
bindKeys();
const press = (key, typing = false) => attemptKeydown({
  ...ev(key), preventDefault() {},
  target: { matches: () => typing },
});
const chord = (key) => { press('a'); press(key); };
chord(']');
ok(S.selected === 'two' && taskMoves === 0, 'a ] selects the next attempt without switching tasks');
chord('[');
ok(S.selected === 'one', 'a [ selects the previous attempt');
chord('[');
ok(S.selected === 'three', 'previous attempt wraps to the last');
chord(']');
ok(S.selected === 'one', 'next attempt wraps to the first');
chord('n');
ok(newAttempts === 1, 'a n invokes the existing draft creation control');
addAttempt.disabled = true;
chord('n');
ok(newAttempts === 1, 'disabled creation cannot be invoked by shortcut');
addAttempt.disabled = false;
press('a', true); press('n', true);
ok(newAttempts === 1, 'typing a n does not create an attempt');
overlayCount = 1;
chord('n');
ok(newAttempts === 1, 'overlays retain ownership of attempt chords');
overlayCount = 0;
links = [links[0]];
ok(allCommands().filter((c) => ['task.attempt.next', 'task.attempt.prev'].includes(c.id)).every((c) => !c.available),
  'a single attempt has no navigation commands');
S.selected = null;
ok(allCommands().filter((c) => c.id.startsWith('task.attempt.')).every((c) => !c.available),
  'attempt commands are unavailable outside a task');
resetChord();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
