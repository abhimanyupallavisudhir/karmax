// One conversation with several agents (software-dev ≥1.27): the thread shows
// each speaker, every agent's work items, and the composer's recipients.
// Run: node web/shared-conversation.test.cjs
const fs = require('fs');
const path = require('path');
const assert = require('assert');
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
global.renderMessageFiles = () => '';
global.markdownEnabled = () => false;
global.mathjaxEnabled = () => false;
global.renderMessageBody = (t) => global.esc(t);
global.renderAgentMessageBody = (t) => global.esc(t);
global.messageCopyButton = () => '';
global.explainMessageAffordance = () => '';
global.conversationTimeHtml = () => '';
global.resourceReviewPlaceholder = () => '';
global.principalLabel = (p) => ({ 'user-2': 'Bea' }[p.userId] || p.userId);
global.S = {
  user: { id: 'user-1' },
  teams: [{ slug: 'qa', name: 'QA' }],
  meta: {},
  taskEvents: [
    { seq: 1, ts: 1710000001000, type: 'agent.activity', payload: { role: 'do', participant: 'do', turnId: 't1', id: 'cmd', kind: 'command', phase: 'completed', title: 'npm test' } },
    { seq: 2, ts: 1710000002000, type: 'agent.activity', payload: { role: 'responder', participant: 'responder', turnId: 't2', id: 'look', kind: 'command', phase: 'completed', title: 'cat README.md' } },
    { seq: 3, ts: 1710000003000, type: 'agent.activity', payload: { role: 'confirm', participant: 'confirm', turnId: 't3', id: 'diff', kind: 'command', phase: 'completed', title: 'git diff' } },
  ],
};
for (const fn of ['sharedConversation', 'participantLabelOf', 'messageSpeaker', 'recipientLabel', 'recipientsHtml', 'composeRecipients',
  'nextAgentKeyFor', 'taskTranscripts', 'conversationTextKey', 'conversationEntries', 'renderConversationEntry']) eval(extractFn(fn));

const view = {
  taskId: 'task-1',
  participants: [
    { key: 'do', label: 'Agent', role: 'do', state: 'idle', messages: 2 },
    { key: 'responder', label: 'Responder', role: 'responder', state: 'idle', messages: 1 },
    { key: 'confirm', label: 'Reviewer', role: 'confirm', state: 'running', messages: 0 },
  ],
  messages: [
    { id: 'm0', role: 'user', text: 'Build X', ts: 1710000000000 },
    { id: 'm1', role: 'agent', text: 'Should X use Y?', ts: 1 },
    { id: 'm2', role: 'agent', author: 'responder', to: ['agent:do'], text: 'Yes, Y.', ts: 2 },
    { id: 'm3', role: 'user', author: 'user-2' && 'user:user-2', to: ['agent:confirm', 'user:user-1'], text: '@Reviewer also check Z', ts: 1710000002500 },
  ],
  transcripts: [{ role: 'do', label: 'Do agent', messages: [] }, { role: 'responder', label: 'Responder agent', messages: [] }],
};
S.view = view;

// One conversation, not a transcript per role.
const transcripts = taskTranscripts(view);
assert.deepStrictEqual(transcripts.map((t) => t.role), ['do']);
assert.strictEqual(transcripts[0].shared, true);

// Every agent's work items are in the thread, each tagged with its speaker.
const entries = conversationEntries(transcripts[0]);
const activities = entries.filter((e) => e.type === 'activity');
assert.deepStrictEqual(activities.map((e) => [e.activity.title, e.speaker]), [['npm test', 'do'], ['cat README.md', 'responder'], ['git diff', 'confirm']]);

const html = entries.map((entry) => renderConversationEntry(entry, view)).join('\n');
assert.match(html, /<span class="role">Responder<\/span>/);
assert.match(html, /<span class="role">Bea<\/span><span class="msg-to" title="Addressed to">→ Reviewer, user-1<\/span>/);
assert.match(html, /<span class="role">You<\/span>/, 'the creator\'s own message is "You"');
assert.match(html, /class="activity-speaker">Reviewer<\/span><span class="activity-title">git diff/);
assert.doesNotMatch(html, /class="activity-speaker">Agent</, 'the main agent\'s work needs no tag');
assert.match(html, /class="msg agent other-agent"/);
// A plain follow-up to the main agent shows no recipients.
assert.strictEqual(recipientsHtml({ role: 'user', to: ['agent:do'] }, view), '');

// Composer recipients follow the mention order; text first also reaches the agent.
assert.deepStrictEqual(composeRecipients('Fix it, @Reviewer check', [{ selector: 'agent:confirm', index: 8 }]), ['agent:do', 'agent:confirm']);
assert.deepStrictEqual(composeRecipients('@Reviewer then @Bea', [{ selector: 'user:user-2', index: 15 }, { selector: 'agent:confirm', index: 0 }]),
  ['agent:confirm', 'user:user-2']);
assert.deepStrictEqual(composeRecipients('just text', []), ['agent:do']);
assert.strictEqual(nextAgentKeyFor(['do', 'responder', 'confirm']), 'agent-3');
assert.strictEqual(participantLabelOf('agent-3', view), 'Agent 3');

// Historical tasks keep their per-role transcripts.
const legacy = { taskId: 't', messages: [], transcripts: [{ role: 'do', label: 'Do agent', messages: [] }, { role: 'confirm', label: 'Confirm agent', messages: [] }] };
assert.deepStrictEqual(taskTranscripts(legacy).map((t) => t.role), ['do', 'confirm']);

console.log('shared-conversation: ok');
