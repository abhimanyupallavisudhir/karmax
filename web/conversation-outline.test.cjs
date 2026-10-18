// The conversation's outline: what people said and the agent's answers stay in
// view; the work between them (tool steps, progress notes, tavya's own prompts
// and the agent's replies to those) folds into one line.
// Run: node web/conversation-outline.test.cjs
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

function extractFn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0;
  const open = src.indexOf('{', start);
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}
global.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
global.S = { user: { id: 'me' }, meta: {}, conversationFolds: {} };
global.siteName = () => 'tavya';
for (const fn of ['messageOrigin', 'conversationOutline', 'foldDuration', 'foldPreview', 'conversationFoldHead', 'sharedConversation', 'participantLabelOf', 'messageSpeaker']) eval(extractFn(fn));

let pass = 0;
let fail = 0;
const ok = (condition, message) => condition ? pass++ : (fail++, console.error('FAIL:', message));
const T0 = 1792280000000;
const msg = (id, role, text, extra = {}) => ({ type: 'message', message: { id, role, text, ts: T0 + 60_000 * Number(id.replace(/\D/g, '') || 0), ...extra }, ts: 0, sourceKey: `message:${id}` });
const act = (n, title = `step ${n}`) => ({ type: 'activity', activity: { kind: 'command', phase: 'completed', title }, ts: T0 + 60_000 * n + 30_000, sourceKey: `activity:${n}` });
const keys = (items) => items.map((item) => item.fold ? `[${item.entries.map((e) => e.sourceKey.split(':')[1]).join(' ')}]` : item.entry.sourceKey.split(':')[1]).join(' ');

// Who wrote what. tavya's prompts are role 'user' (the model must read them),
// but no person wrote them.
ok(messageOrigin({ id: 'm0', role: 'user' }) === 'person', 'the opening prompt is the creator\'s');
ok(messageOrigin({ id: 'ux', role: 'user', author: 'user:me' }) === 'person', 'a signed follow-up is a person\'s');
ok(messageOrigin({ id: 'ux', role: 'user', author: 'task:t2', authorLabel: 'Task #2' }) === 'person', 'another task speaking is not tavya');
ok(messageOrigin({ id: 'u0f0e0d0c-1111-2222-3333-444455556666', role: 'user' }) === 'person', 'an unsigned follow-up from before 1.27 stays a person\'s');
ok(messageOrigin({ id: 'n0f0e0d0c-1111-2222-3333-444455556666', role: 'user' }) === 'platform', 'a gateway notice is tavya\'s');
for (const id of ['wait-4', 'merge-revise-6', 'review-ci-3', 'pr-conflict-9', 'st-2', 'jobs-5', 'prn-12', 'cv3', 'sh-8'])
  ok(messageOrigin({ id, role: 'user' }) === 'platform', `${id} is one of tavya's prompts`);
ok(messageOrigin({ id: 'p-3', role: 'user' }) === 'person', 'an answer relayed from above is not tavya\'s');
ok(messageOrigin({ id: 'm1', role: 'user' }) === 'person' && messageOrigin({ id: 'x7', role: 'user' }) === 'person', 'an unsigned message tavya does not recognise as its own stays a person\'s');
ok(messageOrigin({ id: 'cr-1', role: 'system' }) === 'platform', 'system notes are tavya\'s');
ok(messageOrigin({ id: 'a1', role: 'agent' }) === 'agent', 'agents speak for themselves');
ok(messageSpeaker({ id: 'merge-revise-6', role: 'user', text: 'x' }, { participants: [] }) === 'tavya', 'tavya\'s prompt is no longer labelled "You"');
ok(messageSpeaker({ id: 'u1', role: 'user', author: 'user:me', text: 'x' }, { participants: [] }) === 'You', 'your own messages still say You');

// Task #templates (production, 2026-10-16): the report for the person is a5;
// two merge-conflict rounds followed it.
const templates = [
  msg('m0', 'user', 'Let there be task templates'),
  act(1), msg('a1', 'agent', 'Moving to a larger machine.'),
  msg('wait-2', 'user', '(Resumed: your 3-minute pause is over.)'),
  act(2), act(3), msg('a3', 'agent', 'Waiting for the regression run.'),
  msg('wait-4', 'user', '(Resumed: your job has finished.)'),
  act(4), msg('a5', 'agent', 'Task templates are built and the PR is open.'), act(5, 'open_pr'),
  msg('merge-revise-6', 'user', 'Pull request #669 conflicts with the latest target.'),
  act(6), msg('a7', 'agent', 'Merged master; tests running.'),
  msg('wait-8', 'user', '(Resumed: your job has finished.)'),
  msg('a9', 'agent', 'Back in line to land.'),
  msg('merge-revise-10', 'user', 'Pull request #669 conflicts with the latest target.'),
  msg('a11', 'agent', 'Merged the newest master.'),
  msg('wait-12', 'user', '(Resumed: your job has finished.)'),
  msg('a13', 'agent', 'The branch now merges cleanly with the newest master, and I\'ve requested landing again.'),
];
let outline = conversationOutline(templates);
ok(keys(outline) === 'm0 [1 a1 wait-2 2 3 a3 wait-4 4] a5 [5 merge-revise-6 6 a7 wait-8 a9 merge-revise-10 a11 wait-12 a13]',
  `the prompt and its answer stay; the work and the landing repairs fold: ${keys(outline)}`);
const [, work, , repairs] = outline;
ok(work.fold && work.automatic === 0, 'the work before the answer is a work fold');
ok(repairs.automatic === 2, 'the repairs count the two automatic follow-ups');
ok(repairs.latest?.message?.id === 'a13', 'the repairs fold previews where things stand now');
ok(outline[2].reply === true, 'the answer is marked as the reply');

// A CI failure while the proposal waited for Review: the original report stays.
outline = conversationOutline([
  msg('m0', 'user', 'Ship it'), act(1), msg('a1', 'agent', 'Built it; the PR is open.'),
  msg('review-ci-2', 'user', 'CI #2107 concluded failure.'), act(2), msg('a3', 'agent', 'Fixed the two regressions CI caught.'),
]);
ok(keys(outline) === 'm0 1 a1 [review-ci-2 2 a3]', `a lone step stays inline; the CI repair folds: ${keys(outline)}`);

// A person's message is always shown with the agent message it answers; a
// lone prompt of tavya's still folds (they are long instructions to the agent).
outline = conversationOutline([
  msg('m0', 'user', 'Do it'), msg('a1', 'agent', 'Done; PR open.'),
  msg('review-ci-2', 'user', 'CI failed.'), msg('a3', 'agent', 'CI needs secrets/NPM_TOKEN, which I cannot read. Can you grant it?'),
  msg('u4', 'user', 'Granted.', { author: 'user:me' }), act(4), msg('a5', 'agent', 'CI passes now.'),
]);
ok(keys(outline) === 'm0 a1 [review-ci-2] a3 u4 4 a5', `what you answered stays next to your answer: ${keys(outline)}`);

// An agent message addressed to a person is for them, wherever it falls.
outline = conversationOutline([
  msg('m0', 'user', 'Go'), msg('a1', 'agent', 'Done.'),
  msg('st-2', 'user', 'Sub-task finished.'), msg('a3', 'agent', '@Ann the sub-task needs your login.', { to: ['user:ann'] }),
  act(4), act(5),
]);
ok(keys(outline) === 'm0 a1 [st-2] a3 [4 5]', `a message to a person is never folded: ${keys(outline)}`);

// While the agent works on a fresh request nothing is its answer yet, and the
// work in progress stays open to watch.
outline = conversationOutline([
  msg('m0', 'user', 'Go'), act(1), msg('a1', 'agent', 'Starting with the tests.'), act(2),
], { live: true });
ok(keys(outline) === 'm0 [1 a1 2]', `a progress note is not the answer: ${keys(outline)}`);
ok(outline[1].live === true, 'the work in progress is the live fold');

// When the task is asking a person something, its latest message is the question.
outline = conversationOutline([
  msg('m0', 'user', 'Go'), msg('a1', 'agent', 'Done.'),
  msg('merge-revise-2', 'user', 'Conflicts.'), act(2), msg('a3', 'agent', 'Which side of the conflict should win?'),
], { asking: true });
ok(keys(outline) === 'm0 a1 [merge-revise-2 2] a3', `the open question stays in view: ${keys(outline)}`);

// A system note records something that happened (who stopped an agent, a
// reviewer's decision): already one quiet line, it is never folded away.
outline = conversationOutline([
  msg('m0', 'user', 'Go'), act(1), act(2), msg('a3', 'agent', 'Done.'),
  msg('u4', 'user', 'Take your time.', { author: 'user:me' }), act(5), act(6),
  msg('stop-7', 'system', 'Ann Author stopped Agent 1.'),
]);
ok(keys(outline) === 'm0 [1 2] a3 u4 [5 6] stop-7', `system notes stay in view: ${keys(outline)}`);

// Explanations travel with the message they explain.
outline = conversationOutline([
  msg('m0', 'user', 'Go'), act(1), act(2), msg('a3', 'agent', 'Done.'),
  { type: 'explanation', explanation: { text: 'In short…' }, sourceKey: 'explanation:x' },
]);
ok(keys(outline) === 'm0 [1 2] a3 x', `an explanation follows its message: ${keys(outline)}`);

// The fold line itself: a duration for work, a count and the latest state for
// automatic rounds. The preview drops Markdown and keeps one line.
ok(foldDuration(0, 45_000) === '45 s' && foldDuration(0, 12 * 60_000) === '12 min' && foldDuration(0, 80 * 60_000) === '1 h 20 min', 'durations read naturally');
ok(foldPreview('**PR #671** is repaired.\n\n- Merge: done') === 'PR #671 is repaired.', 'the preview is the first line without Markdown');
const head = conversationFoldHead(conversationOutline(templates)[3]);
ok(head.includes('2 automatic follow-ups') && head.includes('requested landing again'), `the repairs line says how many and where things stand: ${head}`);
ok(conversationFoldHead(conversationOutline(templates)[1]).includes('Worked'), 'a work fold says how long the agent worked');

console.log(`conversation-outline: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
