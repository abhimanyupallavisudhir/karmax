// Regression checks for the shared immediate-feedback layer that binds a
// user-originated request to its initiating control.
// Run: node web/action-feedback.test.cjs
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

function extractFn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0;
  const open = src.indexOf('{', start);
  for (let index = open; index < src.length; index++) {
    if (src[index] === '{') depth++;
    else if (src[index] === '}' && --depth === 0) return src.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

let passed = 0;
let failed = 0;
function ok(condition, message) {
  if (condition) passed++;
  else { failed++; console.error('FAIL:', message); }
}

const classes = new Set();
const attrs = new Map();
const control = {
  disabled: false,
  isConnected: true,
  textContent: 'Save changes',
  title: '',
  classList: {
    add: (...names) => names.forEach((name) => classes.add(name)),
    remove: (...names) => names.forEach((name) => classes.delete(name)),
  },
  getAttribute: (name) => attrs.has(name) ? attrs.get(name) : null,
  setAttribute: (name, value) => attrs.set(name, value),
  removeAttribute: (name) => attrs.delete(name),
};
const progress = {
  hidden: true,
  dataset: {},
  setAttribute(name, value) { attrs.set(`progress:${name}`, value); },
};

global.document = { getElementById: (id) => id === 'action-progress' ? progress : null };
global.actionProgressCount = 0;
global.actionFeedbackStates = new WeakMap();
global.interactionOrigin = control;

eval(extractFn('actionLabel'));
eval(extractFn('beginActionFeedback'));
eval(extractFn('finishActionFeedback'));

const ticket = beginActionFeedback(control);
ok(progress.hidden === false, 'the global dispatch trace appears immediately');
ok(classes.has('action-pending'), 'the initiating control receives a pending state immediately');
ok(attrs.get('aria-busy') === 'true' && attrs.get('aria-disabled') === 'true', 'the pending control exposes busy and unavailable accessibility state');
ok(attrs.get('progress:aria-label') === 'Save changes in progress', 'the progress state names the initiating action');

finishActionFeedback(ticket, true);
setTimeout(() => {
  ok(!classes.has('action-pending') && classes.has('action-succeeded'), 'a successful request resolves to visible completion feedback');
  ok(control.disabled === false && !attrs.has('aria-busy') && !attrs.has('aria-disabled'), 'the control restores its accessibility state without overriding handler-owned disabled state');
  ok(progress.dataset.outcome === 'success', 'the dispatch trace resolves with the request outcome');

  const submitStart = src.indexOf('const submit = async (draftMode, authorizationDecision, activeFeedback)');
  const beginFeedback = src.indexOf('activeFeedback = beginActionFeedback', submitStart);
  const drainAutosave = src.indexOf('await saveChain.catch', submitStart);
  const finishFeedback = src.indexOf('finishActionFeedback(activeFeedback, succeeded)', submitStart);
  ok(submitStart >= 0 && beginFeedback > submitStart, 'expanded-form submit owns an explicit feedback lifecycle');
  ok(beginFeedback < drainAutosave, 'expanded-form feedback starts before waiting for auto-save');
  ok(finishFeedback > drainAutosave, 'expanded-form feedback spans the complete submit operation');
  ok(src.includes("submitButtons.forEach((button) => { button.disabled = true; })"), 'both expanded-form actions are guarded while posting');
  ok(src.includes('if (!currentStateAlreadySaved)'), 'submit does not rewrite fields that auto-save already persisted');
  ok(src.includes('knownDraftAttemptIds = [primaryId, ...alternates.map((attempt) => attempt.id)]'), 'auto-saved tasks retain the exact attempt ids they create');
  ok(src.includes('Promise.all(knownDraftAttemptIds.map((taskId)'), 'known draft attempts queue directly without a group lookup');
  ok(src.includes('const alreadyStarted = createdWithAttempts && !hasPolicy()'), 'direct task creation skips the redundant attempt-group reload');
  ok(src.includes('await Promise.all((group?.attempts || [])'), 'alternate attempts queue in parallel when follow-up queueing is required');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}, 230);
