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
global.S = {
  taskEvents: [
    { seq: 1, ts: 1710000001000, type: 'agent.activity', payload: { role: 'do', turnId: 'turn-1', id: 'turn', kind: 'turn', phase: 'started', title: 'Agent started working' } },
    { seq: 2, ts: 1710000002000, type: 'agent.activity', payload: { role: 'do', turnId: 'turn-1', id: 'cmd', kind: 'command', phase: 'started', title: 'npm test' } },
    { seq: 3, ts: 1710000003000, type: 'agent.activity', payload: { role: 'do', turnId: 'turn-1', id: 'cmd', kind: 'command', phase: 'completed', title: 'npm test', detail: '12 passed' } },
    { seq: 4, ts: 1710000004000, type: 'agent.activity', payload: { role: 'do', turnId: 'turn-1', id: 'reply', kind: 'message', phase: 'completed', title: 'All done' } },
  ],
};

for (const fn of ['conversationEntries', 'conversationTime', 'conversationTimeHtml', 'renderConversationEntry']) eval(extractFn(fn));

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
