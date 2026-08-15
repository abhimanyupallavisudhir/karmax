// Regression coverage for the provider-native conversation timeline.
// Run: node web/conversation.test.cjs
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
global.renderMessageImages = () => '';
// Markdown/copy are exercised by markdown.test.cjs; here we pin the plain path so
// these assertions stay about the timeline, not the message body renderer.
global.markdownEnabled = () => false;
global.renderMessageBody = (t) => global.esc(t);
global.messageCopyButton = () => '';
global.hostLocal = () => true;
global.ICON = { more: '<svg></svg>' };
global.taskRecord = () => ({ projectId: 'project-1' });
global.projectById = () => ({ id: 'project-1', organizationId: 'org-1' });
global.organizationById = () => ({ id: 'org-1' });
global.currentOrg = () => ({ id: 'org-1' });
global.globalRoute = () => '/org/settings';
global.projectRoute = () => '/org/project/settings';
global.taskUrl = (id) => `/acme/app/tasks/${id}`;
const preferences = new Map();
global.localStorage = {
  getItem: (key) => preferences.has(key) ? preferences.get(key) : null,
  setItem: (key, value) => preferences.set(key, value),
};
global.S = {
  user: { id: 'user-1' },
  view: { taskId: 'task-1', worldPath: '/work/task-1' },
  taskEvents: [
    { seq: 1, ts: 1710000001000, type: 'agent.activity', payload: { role: 'do', turnId: 'turn-1', id: 'turn', kind: 'turn', phase: 'started', title: 'Agent started working' } },
    { seq: 2, ts: 1710000002000, type: 'agent.activity', payload: { role: 'do', turnId: 'turn-1', id: 'cmd', kind: 'command', phase: 'started', title: 'npm test' } },
    { seq: 3, ts: 1710000003000, type: 'agent.activity', payload: { role: 'do', turnId: 'turn-1', id: 'cmd', kind: 'command', phase: 'completed', title: 'npm test', detail: '12 passed' } },
    { seq: 4, ts: 1710000004000, type: 'agent.activity', payload: { role: 'do', turnId: 'turn-1', attempt: 1, id: 'reply', kind: 'message', phase: 'completed', title: 'All done' } },
  ],
  explanationSettings: { model: 'google/gemini-3.6-flash' },
  explanationPending: {},
  explanationErrors: {},
};

global.DEFAULT_EXPLANATION_SETTINGS = { model: 'google/gemini-3.6-flash' };
for (const fn of ['conversationEntries', 'conversationTime', 'conversationTimeHtml', 'worldFileTarget', 'fileTargetQuery', 'worldFileHref', 'decodeMarkdownAttribute', 'renderConversationText', 'annotateWorldFileLinks', 'renderAgentMessageBody', 'explanationModelLabel', 'explainMessageAffordance', 'renderConversationEntry']) eval(extractFn(fn));

let pass = 0;
let fail = 0;
const ok = (condition, message) => condition ? pass++ : (fail++, console.error('FAIL:', message));
const transcript = {
  role: 'do',
  messages: [
    { id: 'u1', role: 'user', text: 'Please run the tests', ts: 1710000000000 },
    { id: 'a1', role: 'agent', text: 'The workflow copy need not text-match', ts: 2,
      sourceActivity: { turnId: 'turn-1', id: 'reply', attempt: 1 } },
  ],
};
const entries = conversationEntries(transcript);
ok(entries.length === 4, 'start/completed command updates collapse and stored final reply is de-duplicated');
ok(entries.filter((e) => e.activity?.id === 'cmd').length === 1, 'one command row remains');
ok(entries.find((e) => e.activity?.id === 'cmd')?.activity.phase === 'completed', 'command row carries final status');
ok(entries[0].message?.role === 'user', 'the real user prompt stays first');
const html = entries.map(renderConversationEntry).join('');
ok(html.includes('You') && html.includes('Please run the tests'), 'user message is visibly attributed');
ok(html.includes('npm test') && html.includes('completed'), 'agent action and its state are visible');
ok(html.includes('<time'), 'timestamps are rendered');
ok((html.match(/All done/g) || []).length === 1, 'assistant final text is shown exactly once');
ok(!html.includes('need not text-match'), 'the linked workflow transcript copy is suppressed by provider identity');
ok(html.includes('Explain this with gemini-3.6-flash'), 'agent messages offer the effective explanation model');
const eventOrder = S.taskEvents;
S.taskEvents = [...eventOrder].reverse();
const shuffled = conversationEntries(transcript);
ok(shuffled.filter((entry) => entry.activity?.id === 'cmd').length === 1
  && shuffled.find((entry) => entry.activity?.id === 'cmd')?.activity.phase === 'completed',
  'provider updates fold by durable sequence even when fetch and websocket events arrive out of array order');
S.taskEvents = eventOrder;
const legacyEntries = conversationEntries({ role: 'do', messages: [
  { id: 'legacy-a1', role: 'agent', text: 'All done', ts: 2 },
] });
ok(legacyEntries.filter((entry) => entry.activity?.title === 'All done' || entry.message?.text === 'All done').length === 1,
  'historical transcript copies still de-duplicate by exact text');
const agedOutEntries = conversationEntries({ role: 'do', messages: [
  { id: 'new-a1', role: 'agent', text: 'Archived final', ts: 2,
    sourceActivity: { turnId: 'turn-outside-event-window', id: 'reply', attempt: 1 } },
] });
ok(agedOutEntries.some((entry) => entry.message?.text === 'Archived final'),
  'a linked transcript remains visible after its provider event ages out of the bounded window');
S.taskEvents.push({ seq: 8, ts: 1710000007000, type: 'agent.activity', payload: {
  role: 'do', turnId: 'turn-1', attempt: 1, id: 'reply-again', kind: 'message', phase: 'completed', title: 'All done',
} });
const repeatedProviderEntries = conversationEntries(transcript);
ok(repeatedProviderEntries.filter((entry) => entry.activity?.title === 'All done').length === 1,
  'duplicate provider message items in one turn collapse to the last copy');
S.taskEvents.pop();
const replacedProviderIdEntries = conversationEntries({ role: 'do', messages: [
  { id: 'replaced-id', role: 'agent', text: 'All done', ts: 2,
    sourceActivity: { turnId: 'turn-1', id: 'provider-replaced-this-id', attempt: 1 } },
] });
ok(replacedProviderIdEntries.filter((entry) => entry.activity?.title === 'All done' || entry.message?.id === 'replaced-id').length === 1,
  'a replaced provider item id still de-duplicates the final reply within its turn');
const sameTextOtherTurnEntries = conversationEntries({ role: 'do', messages: [
  { id: 'other-turn', role: 'agent', text: 'All done', ts: 2,
    sourceActivity: { turnId: 'turn-2', id: 'reply', attempt: 1 } },
] });
ok(sameTextOtherTurnEntries.filter((entry) => entry.activity?.title === 'All done' || entry.message?.id === 'other-turn').length === 2,
  'the turn-scoped fallback preserves a genuinely repeated reply from another turn');
const legacyLineEndingEntries = conversationEntries({ role: 'do', messages: [
  { id: 'legacy-crlf', role: 'agent', text: 'All done\r\n', ts: 2 },
] });
ok(legacyLineEndingEntries.filter((entry) => entry.activity?.title === 'All done' || entry.message?.id === 'legacy-crlf').length === 1,
  'historical provider/transcript copies de-duplicate across line-ending normalization');
S.explanationErrors['activity:4'] = { code: 'explanation_api_key_missing', provider: 'openrouter' };
const missingKey = renderConversationEntry(entries.find((entry) => entry.sourceKey === 'activity:4'));
ok(missingKey.includes('API key for openrouter not found') && missingKey.includes('#settings-agents') && missingKey.includes('#project-explanation'), 'missing-key guidance links to agent logins and the project explanation default');
delete S.explanationErrors['activity:4'];

// Explanations are durable annotations attached immediately beneath their source,
// not workflow messages that get replayed to the coding agent.
S.taskEvents.push({ seq: 7, ts: 1710000006000, type: 'conversation.explanation', payload: {
  role: 'do', sourceKey: 'activity:4', text: 'The work is complete.', provider: 'openrouter', model: 'google/gemini-3.6-flash',
} });
const explained = conversationEntries(transcript);
const sourceIndex = explained.findIndex((entry) => entry.sourceKey === 'activity:4');
ok(explained[sourceIndex + 1]?.type === 'explanation', 'a durable explanation renders directly after its source message');
ok(renderConversationEntry(explained[sourceIndex + 1]).includes('Explanation'), 'the annotation is visibly labelled Explanation');

// Explanations are loaded independently from the bounded activity window. The
// API includes the old source event so its annotation does not fall to the end
// of a long conversation after that provider item ages out.
const fullEvents = S.taskEvents;
const sourceEvent = fullEvents.find((event) => event.seq === 4);
S.taskEvents = [{ seq: 9, ts: 1710000009000, type: 'conversation.explanation', payload: {
  role: 'do', sourceKey: 'activity:4', text: 'Recovered explanation', sourceEvent,
} }];
const bounded = conversationEntries(transcript);
const recoveredSource = bounded.findIndex((entry) => entry.activity?.id === 'reply');
ok(recoveredSource >= 0 && bounded[recoveredSource + 1]?.explanation?.text === 'Recovered explanation',
  'an explanation stays beneath a source activity recovered from outside the bounded event window');

// A provider can publish another update for the same message after Explain was
// clicked. Match by provider identity as well as the old event sequence.
S.taskEvents.unshift({ seq: 8, ts: 1710000008000, type: 'agent.activity', payload: {
  role: 'do', turnId: 'turn-1', attempt: 1, id: 'reply', kind: 'message', phase: 'completed', title: 'All done (final)',
} });
const updated = conversationEntries(transcript);
const updatedSource = updated.findIndex((entry) => entry.activity?.id === 'reply');
ok(updatedSource >= 0 && updated[updatedSource + 1]?.type === 'explanation',
  'an explanation remains attached when its provider message receives a later update');
S.taskEvents = fullEvents;

// A follow-up accepted while the agent is still running is journaled before the
// workflow republishes its transcript, so it must appear from the event alone.
const followUp = { id: 'u-live', role: 'user', text: 'One more requirement', ts: 1710000005000 };
S.taskEvents.push({ seq: 5, ts: followUp.ts, type: 'conversation.message', payload: { role: 'do', message: followUp } });
let liveEntries = conversationEntries(transcript);
ok(liveEntries.some((entry) => entry.message?.id === 'u-live'), 'mid-turn user messages render from the durable event');

// Optimistic rendering and the WebSocket can both carry the event, then the
// workflow snapshot eventually catches up. All three copies still render once.
S.taskEvents.push({ seq: 6, ts: followUp.ts, type: 'conversation.message', payload: { role: 'do', message: followUp } });
transcript.messages.push(followUp);
liveEntries = conversationEntries(transcript);
ok(liveEntries.filter((entry) => entry.message?.id === 'u-live').length === 1, 'event and stored transcript copies are de-duplicated');

const linked = renderConversationText('See [app.js](/work/task-1/web/app.js:42) and [docs](https://example.com).', 'agent', S.view);
ok(linked.includes('href="/acme/app/tasks/task-1/file?path=%2Fwork%2Ftask-1%2Fweb%2Fapp.js&amp;line=42"'), 'an agent file link gets a durable task-scoped handoff URL');
ok(!linked.includes('/file?path=https'), 'external links are never treated as world files');
ok(worldFileTarget('/work/task-1/web/app.js#L9', S.view.worldPath).line === 9, 'GitHub-style line fragments are parsed');
ok(worldFileTarget('/other/task/app.js:3', S.view.worldPath) === null, 'absolute paths outside the task world are not intercepted');
ok(worldFileTarget('/workspace/web/app.js:3', undefined, true).path === '/workspace/web/app.js', 'cloud-world file links are intercepted without leaking the remote root');
const cloudLinked = renderConversationText('[app.js](/workspace/web/app.js:3)', 'agent', { taskId: 'task-cloud', worldAvailable: true });
ok(cloudLinked.includes('/acme/app/tasks/task-cloud/file?path=%2Fworkspace%2Fweb%2Fapp.js&amp;line=3'), 'cloud-world file links keep working when this browser is not on the gateway host');
const markdownLinked = annotateWorldFileLinks('<p><a href="/work/task-1/web/app.js:42" target="_blank">app.js</a></p>', S.view);
ok(markdownLinked.includes('/acme/app/tasks/task-1/file?path=%2Fwork%2Ftask-1%2Fweb%2Fapp.js&amp;line=42'), 'the default Markdown path emits the same durable handoff URL');
ok(renderConversationText('[app](/work/task-1/app.js)', 'user', S.view).includes('[app]('), 'user-authored Markdown remains literal');

// Regression (Task 311): the workflow stamps agent/system replies with a per-array
// sequence number while user messages carry real epoch-ms timestamps. A reply must
// stay right after the message it answers, not be flung to the top of the timeline
// by its tiny `ts`. Use a role with no activity events so ordering is what's tested.
const ordered = conversationEntries({
  role: 'merge',
  messages: [
    { id: 'm0', role: 'user', text: 'first request', ts: 1785089970324 },
    { id: 'a1', role: 'agent', text: 'reply one', ts: 1 },
    { id: 'u1', role: 'user', text: 'a follow-up', ts: 1785111313150 },
    { id: 'a2', role: 'agent', text: 'reply two', ts: 3 },
  ],
}).map((entry) => entry.message.id);
ok(ordered.join(',') === 'm0,a1,u1,a2', 'sequence-numbered replies sort after the message they answer, not at the top');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
