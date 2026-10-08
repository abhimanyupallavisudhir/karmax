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
let mathPreference = true;
global.mathjaxEnabled = () => mathPreference;
global.renderMessageBody = (t) => global.esc(t);
global.messageCopyButton = () => '';
global.hostLocal = () => true;
global.ICON = { more: '<svg></svg>', form: '<svg data-icon="file"></svg>' };
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
  projectId: 'project-1',
  token: 'session-token',
  user: { id: 'user-1' },
  view: { taskId: 'task-1', worldPath: '/work/task-1' },
  taskEvents: [
    { seq: 1, ts: 1710000001000, type: 'agent.activity', payload: { role: 'do', turnId: 'turn-1', id: 'turn', kind: 'turn', phase: 'started', title: 'Agent started working' } },
    { seq: 2, ts: 1710000002000, type: 'agent.activity', payload: { role: 'do', turnId: 'turn-1', id: 'cmd', kind: 'command', phase: 'started', title: 'npm test' } },
    { seq: 3, ts: 1710000003000, type: 'agent.activity', payload: { role: 'do', turnId: 'turn-1', id: 'cmd', kind: 'command', phase: 'completed', title: 'npm test', detail: '12 passed' } },
    { seq: 4, ts: 1710000004000, type: 'agent.activity', payload: { role: 'do', turnId: 'turn-1', attempt: 1, id: 'reply', kind: 'message', phase: 'completed', title: 'All done' } },
  ],
  meta: { explanationsEnabled: true },
  explanationSettings: { model: 'google/gemini-3.6-flash' },
  explanationPending: {},
  explanationErrors: {},
};

global.DEFAULT_EXPLANATION_SETTINGS = { model: 'google/gemini-3.6-flash' };
for (const fn of ['safeHref', 'attachmentUrl', 'formatAttachmentBytes', 'renderMessageFiles', 'conversationTextKey', 'conversationEntries', 'conversationTime', 'conversationTimeHtml', 'worldFileTarget', 'fileTargetQuery', 'worldFileHref', 'worldWikiHref', 'worldFileAnchor', 'wikiRoute', 'decodeMarkdownAttribute', 'renderConversationText', 'annotateWorldFileLinks', 'renderAgentMessageBody', 'explanationModelLabel', 'explanationsEnabled', 'texToggleHtml', 'explainMessageAffordance', 'sharedConversation', 'participantLabelOf', 'messageSpeaker', 'recipientLabel', 'recipientsHtml', 'renderConversationEntry']) eval(extractFn(fn));

let pass = 0;
let fail = 0;
const ok = (condition, message) => condition ? pass++ : (fail++, console.error('FAIL:', message));
const transcript = {
  role: 'do',
  messages: [
    { id: 'u1', role: 'user', text: 'Please run the tests', ts: 1710000000000,
      files: [{ id: 'a'.repeat(64), name: 'brief.pdf', mediaType: 'application/pdf', bytes: 2048 }] },
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
ok(html.includes('brief.pdf') && html.includes('2 KB'), 'ordinary file attachments render with their name and size');
ok(html.includes('npm test') && html.includes('completed'), 'agent action and its state are visible');
ok(html.includes('<time'), 'timestamps are rendered');
ok((html.match(/All done/g) || []).length === 1, 'assistant final text is shown exactly once');
ok(!html.includes('need not text-match'), 'the linked workflow transcript copy is suppressed by provider identity');
ok(html.includes('Explain this with gemini-3.6-flash'), 'agent messages offer the effective explanation model');
S.meta.explanationsEnabled = false;
const unexplained = explainMessageAffordance({ sourceKey: 'activity:4', conversationRole: 'do' }, S.view);
ok(!unexplained.includes('explain-run') && !unexplained.includes('explain-more') && unexplained.includes('tex-toggle'),
  'with explanations off, messages keep the TeX toggle but offer no Explain button');
S.meta.explanationsEnabled = true;
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
const completedLinked = renderConversationText(
  'Main entry point: [site/index.html](/home/user/karmax/grier/site/index.html)',
  'agent',
  { taskId: 'task-finished', status: 'done' },
);
ok(completedLinked.includes('/acme/app/tasks/task-finished/file?path=%2Fhome%2Fuser%2Fkarmax%2Fgrier%2Fsite%2Findex.html'),
  'a completed task keeps file citations routable after its world availability hint is released');
const markdownLinked = annotateWorldFileLinks('<p><a href="/work/task-1/web/app.js:42" target="_blank">app.js</a></p>', S.view);
ok(markdownLinked.includes('/acme/app/tasks/task-1/file?path=%2Fwork%2Ftask-1%2Fweb%2Fapp.js&amp;line=42'), 'the default Markdown path emits the same durable handoff URL');
ok(renderConversationText('[app](/work/task-1/app.js)', 'user', S.view).includes('[app]('), 'user-authored Markdown remains literal');

// Task 367: a citation of a file in the task's wiki checkout opened a file
// handoff, which cannot contain the wiki. It links to the entry in the wiki
// view, on the task's own branch, whatever form the agent cited it in.
global.projectRoute = (pid, tab) => `/acme/app/${tab}`;
const wikiView = { taskId: 'task-cloud', num: 367, worldWiki: 'app-wiki' };
const wikiLinked = renderConversationText('[review](app-wiki/reviews/2026-09-26/SKILL.md)', 'agent', wikiView);
ok(wikiLinked.includes('href="/acme/app/wiki?task=367#reviews%2F2026-09-26"') && wikiLinked.includes('Open in the wiki'),
  'a relative wiki citation links to its entry on the task branch');
ok(renderConversationText('[m](/home/user/app/app-wiki/notes/MEMORY.md)', 'agent', wikiView).includes('href="/acme/app/wiki?task=367#notes"'),
  'an absolute wiki citation links to its entry');
ok(annotateWorldFileLinks('<a href="../app-wiki/SPEC/diagram.png">d</a>', wikiView).includes('href="/acme/app/wiki?task=367#SPEC"'),
  'an attachment links to the entry holding it');
ok(renderConversationText('[x](src/app-wiki/x.ts)', 'agent', wikiView).includes('/tasks/task-cloud/file?'),
  'a same-named folder elsewhere in a repository is still an ordinary file');

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

// Forking addresses the conversation being viewed, including completed agents
// and sessions without a native CLI/config home.
eval(extractFn('reviewActionBtn'));
eval(extractFn('conversationReviewInfo'));
eval(extractFn('conversationFullscreenButton'));
eval(extractFn('conversationPane'));
eval(extractFn('liveOutputFor'));
eval(extractFn('forkBranchDefaults'));
eval(extractFn('wireCheckinSidebar'));
eval(extractFn('wireStopAgents'));
global.conversationApprovalRequests = () => '<div>Pending approvals</div>';
global.liveRoleFor = () => 'do';
global.localWorldPath = () => false;
global.conversationPresence = () => ({ tone: 'muted', label: 'Finished' });
global.openTaskForm = (...args) => { global.openedForkForm = args; };
const forkView = { taskId: 'source-task', status: 'done', branch: 'tavya/source-task', targetBranch: 'release', actions: [] };
for (const status of ['done', 'cancelled', 'waiting']) {
  forkView.status = status;
  for (const role of ['do', 'merge', 'confirm', 'resolve']) {
    const html = conversationPane(forkView, { role, messages: [] });
    ok(html.includes('Pending approvals'), `${role} conversation includes pending task approvals`);
    ok(html.includes('id="fork-task-agent"') && html.includes(`data-role="${role}"`), `${role} conversation offers a task fork without a CLI session`);
    let click;
    global.$ = (selector) => selector === '#main'
      ? { querySelector: () => null, querySelectorAll: () => [] }
      : selector === '#fork-task-agent'
        ? { addEventListener: (_type, handler) => { click = handler; } }
        : null;
    wireCheckinSidebar(forkView);
    click({ currentTarget: { dataset: { role } } });
    const [workflow, draft, prompt, params] = global.openedForkForm;
    ok(workflow === 'software-dev' && !draft && !prompt
      && params['agent:do'].resumeFrom.taskId === 'source-task'
      && params['agent:do'].resumeFrom.role === role
      && params.base === (status === 'done' ? 'release' : 'tavya/source-task'),
      `${status} ${role} fork opens a new task form with the correct source, branch and an empty next instruction`);
  }
}
ok(!conversationPane(forkView, null).includes('fork-task-agent'), 'missing conversations have no fork action');
const keyTranscript = { role: 'do', messages: [] };
S.taskEvents = [{ seq: 900, ts: 1710000001000, type: 'agent.activity', payload: {
  role: 'do', turnId: 'stable-turn', attempt: 1, id: 'command', kind: 'command', phase: 'started', title: 'npm test',
} }];
const runningKey = conversationPane(forkView, keyTranscript).match(/data-conversation-key="([^"]+)"/)[1];
S.taskEvents.push({ seq: 901, ts: 1710000002000, type: 'agent.activity', payload: {
  ...S.taskEvents[0].payload, phase: 'completed', detail: 'Passed',
} });
const completedKey = conversationPane(forkView, keyTranscript).match(/data-conversation-key="([^"]+)"/)[1];
ok(runningKey === completedKey, 'tool updates keep a stable DOM key across event sequence numbers');
S.taskEvents = [];


// Review info is task-wide, compact, and follows the conversation in every role.
for (const info of [undefined, {}, { completion: 'finished' }]) {
  ok(conversationReviewInfo({ reviewInfo: info }) === '', 'empty review info reserves no space');
}
const reviewView = { ...forkView, reviewInfo: {
  caption: 'Check <layout>',
  actions: [{ kind: 'open', label: 'Report', target: 'report.md' }, { kind: 'run', label: 'Preview', command: 'npm start' }],
  links: [{ label: 'Unsafe link', url: 'javascript:alert(1)' }],
  html: '<iframe>large preview</iframe>',
} };
for (const role of ['do', 'merge', 'confirm', 'resolve']) {
  const html = conversationPane(reviewView, { role, messages: [{ id: 'final', role: 'agent', text: 'Final response', ts: 1 }] });
  ok(html.indexOf('Review info') > html.indexOf('Final response'), `${role} review info follows the conversation`);
  ok(html.includes('Check &lt;layout&gt;'), 'review caption is escaped');
  ok(html.includes('data-idx="1" data-kind="run"'), 'review actions preserve API indices');
  ok(html.includes('class="raw hidden" id="review-action-out"'), 'command output takes no space until run');
  ok(html.includes('href="#"'), 'unsafe legacy link is neutralized');
  ok(html.includes('data-tasktab="overview"') && !html.includes('<iframe>'), 'large preview is linked in Overview');
  ok((html.match(/id="review-actions"/g) || []).length === 1, 'review actions have a single wiring target');
}


// Input prompts use the same model picker, pending/error UI, and durable annotations.
eval(extractFn('humanWaitDetail'));
eval(extractFn('conversationInputRequest'));
S.taskEvents = [];
const requestView = { taskId: 'task-1', status: 'waiting', updatedAt: 1710000010000,
  waitingFor: { kind: 'human', detail: 'Choose a deployment target.' },
  actions: [{ name: 'followUp', enabled: true, roles: ['do'] }] };
const requestTranscript = { role: 'do', messages: [] };
const requestKey = `input-request:${requestView.updatedAt}`;
let requestHtml = conversationPane(requestView, requestTranscript);
ok(requestHtml.includes(`data-source-key="${requestKey}"`) && requestHtml.includes('Explain this with gemini-3.6-flash'),
  'input requests offer the existing explanation controls');
S.explanationPending[requestKey] = true;
ok(conversationPane(requestView, requestTranscript).includes('disabled>Explaining…'), 'input request shows pending explanation');
delete S.explanationPending[requestKey];
S.explanationErrors[requestKey] = { message: 'Try again' };
ok(conversationPane(requestView, requestTranscript).includes('Try again'), 'input request displays explanation errors');
delete S.explanationErrors[requestKey];
S.taskEvents = [{ seq: 30, ts: 1710000011000, type: 'conversation.explanation', payload: {
  role: 'do', sourceKey: requestKey, sourceRequest: { text: requestView.waitingFor.detail, ts: requestView.updatedAt },
  text: 'Pick where the update should go.', model: 'google/gemini-3.6-flash',
} }];
requestHtml = conversationPane(requestView, requestTranscript);
ok((requestHtml.match(/class="msg agent input-request"/g) || []).length === 1, 'explained current prompt appears once');
ok(requestHtml.indexOf('Choose a deployment target.') < requestHtml.indexOf('Pick where the update should go.'), 'explanation follows its input prompt');
const resolvedHtml = conversationPane({ ...requestView, status: 'active', waitingFor: undefined }, requestTranscript);
ok(resolvedHtml.includes('Choose a deployment target.') && resolvedHtml.includes('Pick where the update should go.'), 'resolved prompt and explanation survive reload');
ok(!conversationPane(requestView, { role: 'merge', messages: [] }).includes('input-request'), 'input explanation stays in its own conversation');

// The control is present beside Explain and reflects the global preference.
global.markdownEnabled = () => true;
const mathEntry = { sourceKey: 'message:math', conversationRole: 'merge' };
ok(explainMessageAffordance(mathEntry, S.view).includes('aria-pressed="true"'), 'math toggle reflects enabled preference');
mathPreference = false;
ok(explainMessageAffordance(mathEntry, S.view).includes('aria-pressed="false"'), 'math toggle reflects disabled preference');
ok(explainMessageAffordance({ ...mathEntry, conversationRole: 'do' }, S.view).includes('aria-pressed="false"'), 'every agent conversation shares the preference');
mathPreference = true;
global.markdownEnabled = () => false;
ok(explainMessageAffordance(mathEntry, S.view).includes('disabled><span class="tex-mark"'), 'math toggle explains Markdown prerequisite and is disabled without it');

// Task 219 stored updatedAt=17: a workflow revision must not send an explained
// request to the start of the thread. Include surrounding history (the original
// input-request fixture had no messages and used an epoch timestamp).
const revisionView = { ...requestView, updatedAt: 17 };
const revisionKey = 'input-request:17';
const revisionTranscript = { role: 'do', messages: [
  { id: 'before', role: 'user', text: 'Earlier question', ts: 1710000000000 },
] };
const annotation = { seq: 40, ts: 1710000011000, type: 'conversation.explanation', payload: {
  role: 'do', sourceKey: revisionKey,
  sourceRequest: { text: revisionView.waitingFor.detail, ts: 17 },
  text: 'First explanation',
} };
S.taskEvents = [];
const beforeExplanation = conversationPane(revisionView, revisionTranscript);
ok(beforeExplanation.indexOf('Earlier question') < beforeExplanation.indexOf('Choose a deployment target.'),
  'unexplained revision-stamped request follows prior messages');
S.taskEvents = [annotation];
const afterExplanation = conversationPane(revisionView, revisionTranscript);
ok(afterExplanation.indexOf('Earlier question') < afterExplanation.indexOf('Choose a deployment target.'),
  'explaining a revision-stamped request keeps it after prior messages');
ok((afterExplanation.match(/class="msg agent input-request"/g) || []).length === 1,
  'revision-stamped request remains visible exactly once');
let revisionEntries = conversationEntries(revisionTranscript);
ok(revisionEntries[1].type === 'input-request' && revisionEntries[2].type === 'explanation',
  'explanation stays directly beneath revision-stamped request');
const laterTranscript = { role: 'do', messages: [...revisionTranscript.messages,
  { id: 'later', role: 'user', text: 'Later follow-up', ts: 1710000020000 },
] };
S.taskEvents = [{ ...annotation, seq: 50, ts: 1710000030000,
  payload: { ...annotation.payload, text: 'Second explanation' } }, annotation];
revisionEntries = conversationEntries(laterTranscript);
ok(revisionEntries.map((entry) => entry.type).join(',') === 'message,input-request,explanation,explanation,message',
  'reload and repeated explanation preserve the original request position before later follow-ups');
S.taskEvents.push({ seq: 39, ts: 1710000010000, type: 'view.updated', payload: {
  waitingFor: 'human', waitingDetail: revisionView.waitingFor.detail,
} });
revisionEntries = conversationEntries(laterTranscript);
ok(revisionEntries.find((entry) => entry.type === 'input-request').ts === 1710000010000,
  'durable human-wait event supplies the actual request time when available');
S.taskEvents = [annotation];
ok(conversationPane({ ...revisionView, status: 'active', waitingFor: undefined }, laterTranscript)
  .indexOf('Choose a deployment target.') < conversationPane({ ...revisionView, status: 'active', waitingFor: undefined }, laterTranscript)
  .indexOf('Later follow-up'), 'resolved revision-stamped request survives a bounded history reload in order');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
