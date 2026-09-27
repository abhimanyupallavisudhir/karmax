// Per-urgency notification behaviour: what an ask DOES when it arrives, the
// defaults it does it with, and the promise that opening the app is silent.
// Run: node web/notifications.test.cjs
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

function extractFn(name) {
  const start = src.search(new RegExp(`^function ${name}\\(`, 'm'));
  if (start < 0) throw new Error(`${name} not found`);
  let parens = 0;
  let open = -1;
  for (let i = src.indexOf('(', start); i < src.length; i++) {
    if (src[i] === '(') parens++;
    else if (src[i] === ')') parens--;
    else if (src[i] === '{' && parens === 0) { open = i; break; }
  }
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}
function extractConst(name, terminator = '\n];') {
  const start = src.search(new RegExp(`^const ${name} = `, 'm'));
  if (start < 0) throw new Error(`${name} not found`);
  const end = src.indexOf(terminator, start);
  return src.slice(start, end + terminator.length);
}

// A tiny browser: localStorage that works, no Notification API, no AudioContext.
const store = new Map();
global.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
};
global.esc = (value) => String(value ?? '');
global.S = {};
global.NOTIFY_BEHAVIOURS = undefined;

eval(extractConst('URGENCY_LEVELS').replace('const URGENCY_LEVELS =', 'global.URGENCY_LEVELS ='));
eval(extractConst('NOTIFY_BEHAVIOURS').replace('const NOTIFY_BEHAVIOURS =', 'global.NOTIFY_BEHAVIOURS ='));
eval(extractConst('NOTIFY_DEFAULTS', '\n};').replace('const NOTIFY_DEFAULTS =', 'global.NOTIFY_DEFAULTS ='));
for (const name of ['urgencyRank', 'notifyPrefs', 'setNotifyPref', 'inboxArrivals', 'announceInbox',
  'notificationSoundPrefs', 'showSystemNotification', 'unlockNotificationAudio', 'inboxEventChanges', 'playNotificationSound', 'inboxRowLabel', 'policyTip', 'notificationsCard']) eval(extractFn(name));

let pass = 0;
let fail = 0;
const ok = (condition, message) => condition ? pass++ : (fail++, console.error('FAIL:', message));

// ── defaults ────────────────────────────────────────────────────────────────
const defaults = notifyPrefs();
ok(defaults.critical.visual && URGENCY_LEVELS.filter((x) => x !== 'critical').every((x) => !defaults[x].visual), 'only critical shows in-app by default');
ok(defaults.critical.notify && defaults.critical.sound, 'critical both notifies and sounds by default');
ok(defaults.high.notify && !defaults.high.sound, 'high notifies quietly by default');
ok(!defaults.normal.notify && !defaults.normal.sound, 'normal is silent by default');
ok(!defaults.low.notify && !defaults.low.sound, 'low is silent by default');
ok(URGENCY_LEVELS.every((level) => defaults[level]), 'every urgency level has a behaviour');

// ── the person's choices survive, one level at a time ───────────────────────
setNotifyPref('normal', 'sound', true);
ok(notifyPrefs().normal.sound === true, 'a changed behaviour is remembered');
ok(notifyPrefs().normal.notify === false, 'the other behaviour of that level is untouched');
ok(notifyPrefs().critical.notify === true, 'and the other levels keep their defaults');
setNotifyPref('critical', 'notify', false);
ok(notifyPrefs().critical.notify === false, 'a default can be turned OFF, not just on');
setNotifyPref('critical', 'notify', true);
setNotifyPref('normal', 'sound', false);

// ── arrivals ────────────────────────────────────────────────────────────────
const item = (id, urgency, unread = true) => ({ id, urgency, unread, kind: 'escalated', createdAt: 1,
  task: { num: 7, title: `Task ${id}` } });
const list = [item('a', 'critical'), item('b', 'normal')];
ok(inboxArrivals(null, list).length === 0, 'the FIRST load announces nothing — it only seeds the seen set');
ok(inboxArrivals(new Set(['a']), list).map((x) => x.id).join(',') === 'b', 'only genuinely new asks are announced');
ok(inboxArrivals(new Set(), [item('c', 'high', false)]).length === 0, 'an already-read ask is not announced');

// A restatement remains quiet, but increasing the same ask's priority alerts.
const priorities = new Map([['a', urgencyRank('normal')]]);
ok(inboxArrivals(priorities, [item('a', 'high')]).length === 1, 'priority promotion announces an existing ask');
ok(inboxArrivals(priorities, [item('a', 'normal')]).length === 0, 'unchanged asks stay quiet');
for (const type of ['task.escalated', 'credential.approval-resolved', 'review.requested', 'task.assigned'])
  ok(inboxEventChanges({ type }), `${type} refreshes delivery`);
ok(!inboxEventChanges({ type: 'agent.output' }), 'streaming tokens do not reload the inbox');

// ── what announcing does ────────────────────────────────────────────────────
global.showVisualNotification = () => {};
const shown = [];
const blips = [];                                   // one entry per tone actually started
global.Notification = function (title, options) {
  shown.push({ title, ...options });
  this.close = () => {};
};
global.Notification.permission = 'granted';
const audioContext = () => ({
  currentTime: 0,
  resume() {},
  destination: {},
  createGain: () => ({ gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (node) => node }),
  createOscillator: () => {
    const oscillator = { frequency: { value: 0 }, connect: (node) => node, stop() {},
      start() { blips.push(oscillator.frequency.value); } };
    return oscillator;
  },
});
global.window = { focus: () => {}, AudioContext: function () { return audioContext(); } };

announceInbox([item('a', 'critical'), item('b', 'high'), item('c', 'low')]);
ok(shown.map((n) => n.title).join(',') === 'Task a,Task b', 'critical and high pop up; low does not');
ok(shown[0].requireInteraction === true && shown[1].requireInteraction === false,
  'only a critical popup waits to be dismissed');
ok(shown[0].silent === true, 'native sound cannot override the sound preference');
ok(shown[0].body.startsWith('CRITICAL'), 'system notification names priority');
ok(shown[0].tag === 'a', 'a popup is tagged with its ask, so a restatement replaces it');
shown.length = 0;
showSystemNotification({ id: 'z', urgency: 'critical', kind: 'escalated' });
ok(shown[0].title === 'karmax', 'an ask with no task title falls back to the product name, spelled right');
ok(blips.length === 2 && blips.every((tone) => tone === 880),
  `one sound per batch, at the loudest level that arrived (got ${blips.join(',')})`);

// A quieter batch is a quieter sound, and only if that level asked for one.
blips.length = 0;
announceInbox([item('d', 'high')]);
ok(blips.length === 0, 'high is silent until the person turns its sound on');
setNotifyPref('high', 'sound', true);
announceInbox([item('e', 'high')]);
ok(blips.join(',') === '660', 'a high ask plays one lower blip');
setNotifyPref('high', 'sound', false);

shown.length = 0;
blips.length = 0;
global.Notification.permission = 'denied';
ok(showSystemNotification(item('a', 'critical')) === false, 'without permission nothing is shown');
ok(shown.length === 0, 'and no popup is constructed');

// A browser with no Notification API at all must not throw on the way past.
delete global.Notification;
announceInbox([item('a', 'critical')]);
ok(blips.length === 2, 'the sound still plays where popups are unsupported');

// Sound selection changes the generated tone and caps the playback schedule.
store.set('karmax-notify-sound', JSON.stringify({ tone: 'soft', duration: 3 }));
blips.length = 0;
playNotificationSound('critical');
ok(blips.length === 8 && blips.every((tone) => tone === 440), 'soft sound repeats for the selected three-second duration');
store.set('karmax-notify-sound', JSON.stringify({ tone: 'invalid', duration: 999999 }));
ok(notificationSoundPrefs().tone === 'bell' && notificationSoundPrefs().duration === 0.35, 'invalid sound settings fall back to a bounded brief alert');
store.delete('karmax-notify-sound');

// ── the settings card ───────────────────────────────────────────────────────
const card = notificationsCard();
for (const level of URGENCY_LEVELS) {
  ok(card.includes(`data-notify="${level}:notify"`) && card.includes(`data-notify="${level}:sound"`),
    `${level} has both behaviour switches`);
  ok(card.includes(`data-notify="${level}:visual"`) && card.includes(`data-notify="${level}:email"`), `${level} has visual and email controls`);
  ok(card.includes(`data-notify-test="${level}"`), `${level} can be tested`);
}
ok(card.indexOf('critical') < card.indexOf('>low<'), 'levels are listed loudest first');
ok(card.includes('id="notifications"'), 'the card is linkable from the inbox');
ok(!card.includes('>Delivery<') && !card.includes('data-delivery='),
  'unimplemented delivery preferences are not shown as notification behaviour');
ok(!card.includes('Outcome updates for tasks I follow'),
  'outcome updates are not presented as a delivery destination');

// ── layout regressions ──────────────────────────────────────────────────────
// Two rules the markup above silently depends on. Both were real: `.task-sub` is
// a flex row built for a strip of metadata, and reusing it for a sentence made
// every inline <a> its own gapped flex item — the inbox's "set in your profile"
// link wrapped away from the words around it. In the settings table the chip is
// a grid item, so it stretched across the whole column instead of hugging a word.
const css = fs.readFileSync(path.join(__dirname, 'styles.css'), 'utf8');
ok(/p\.task-sub\s*\{[^}]*display:\s*block/.test(css), 'a prose paragraph flows as prose, not as a flex row');
ok(/\.notify-row\s+\.urgency-chip\s*\{[^}]*justify-self:\s*start/.test(css), 'the chip hugs its word in the settings grid');
ok(!/^\.urgency-chip\s*\{[^}]*margin-left/m.test(css), 'the base chip carries no leading margin of its own');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
