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
eval(extractFn('fmtKeys'));
eval(extractFn('fuzzyScore'));
eval(extractFn('adjacentCheckinPane'));
eval(extractConst('firstLine').replace('const firstLine =', 'global.firstLine ='));
eval(extractFn('quickTaskSubmitMode'));
eval(extractFn('quickTaskPayload'));
eval(extractFn('initialTaskFormSavedSignature'));

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('FAIL:', msg); } };
const ev = (key, mods = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

// ── Quick-add guidance ──
ok(
  src.includes('placeholder="New Task · ↵ for full task form · Ctrl+↵ to send · Ctrl+V to paste image · (n)"'),
  'quick-add placeholder explains its keyboard and paste shortcuts',
);

// The Activity feed is an internal debugging page. Its direct route remains
// usable, but users must not discover it through the tab bar, command palette,
// keyboard help, or a g+a shortcut.
ok(
  src.includes("const tabs = ['tasks', 'queue', 'wiki', 'settings'];"),
  'project navigation omits the debugging-only Activity tab',
);
ok(!src.includes("id: 'nav.activity'"), 'Activity has no user-facing navigation command');

// ── parseKeybinding ──
ok(JSON.stringify(parseKeybinding('n')) === JSON.stringify([{ key: 'n' }]), 'single key');
ok(JSON.stringify(parseKeybinding('g t')) === JSON.stringify([{ key: 'g' }, { key: 't' }]), 'two-step chord');
ok(JSON.stringify(parseKeybinding('meta+k')) === JSON.stringify([{ key: 'k', meta: true }]), 'meta modifier');
ok(JSON.stringify(parseKeybinding('meta+shift+F')) === JSON.stringify([{ key: 'F', meta: true, shift: true }]), 'global-search modifier chord');
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
ok(stepMatches(parseKeybinding('meta+shift+F')[0], ev('F', { ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+F opens global search');
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

// ── shifted chords survive the Shift keydown (g P / g W / g D / g S) ──
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
ok(fmtKeys('meta+shift+F') === 'Ctrl+⇧F', 'global search renders its full shortcut');
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
const sent = quickTaskPayload('run it', 'script-exec', [], false);
const draft = quickTaskPayload('save it', 'software-dev', ['image-1'], true);
ok(sent.quick === true && sent.command === 'run it' && sent.draft === undefined, 'quick send starts immediately');
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
