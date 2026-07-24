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

global.esc = (s) => String(s ?? '').replace(/</g, '&lt;');
global.renderMessageImages = () => '';
// Markdown/copy are exercised by markdown.test.cjs; here we pin the plain path so
// these assertions stay about the timeline, not the message body renderer.
global.markdownEnabled = () => false;
global.renderMessageBody = (t) => global.esc(t);
global.messageCopyButton = () => '';
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
    { seq: 4, ts: 1710000004000, type: 'agent.activity', payload: { role: 'do', turnId: 'turn-1', id: 'reply', kind: 'message', phase: 'completed', title: 'All done' } },
  ],
};

for (const fn of ['conversationEntries', 'conversationTime', 'conversationTimeHtml', 'worldFileTarget', 'fileLinksEnabled', 'setFileLinksEnabled', 'renderConversationText', 'renderAgentMessageBody', 'renderConversationEntry']) eval(extractFn(fn));

let pass = 0;
let fail = 0;
const ok = (condition, message) => condition ? pass++ : (fail++, console.error('FAIL:', message));
const transcript = {
  role: 'do',
  messages: [
    { id: 'u1', role: 'user', text: 'Please run the tests', ts: 1710000000000 },
    { id: 'a1', role: 'agent', text: 'All done', ts: 2 },
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
ok(linked.includes('href="/work/task-1/web/app.js:42"'), 'the agent-provided file href is preserved for copy behavior');
ok(linked.includes('data-world-file="/work/task-1/web/app.js:42"'), 'an in-world file link is marked for click interception');
ok(!linked.match(/data-world-file="https:/), 'external links are never treated as world files');
ok(worldFileTarget('/work/task-1/web/app.js#L9', S.view.worldPath).line === 9, 'GitHub-style line fragments are parsed');
ok(worldFileTarget('/other/task/app.js:3', S.view.worldPath) === null, 'absolute paths outside the task world are not intercepted');
ok(renderConversationText('[app](/work/task-1/app.js)', 'user', S.view).includes('[app]('), 'user-authored Markdown remains literal');
ok(fileLinksEnabled() === true, 'world file links default on');
setFileLinksEnabled(false);
ok(fileLinksEnabled() === false, 'the appearance preference disables world file opening');
S.user = { id: 'user-2' };
ok(fileLinksEnabled() === true, 'the appearance preference is scoped to the signed-in user');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
