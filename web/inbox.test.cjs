// The inbox panel: kind sub-tabs, and read items hidden until asked for.
// Run: node web/inbox.test.cjs
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
function extractConst(name) {
  const start = src.search(new RegExp(`^const ${name} = `, 'm'));
  if (start < 0) throw new Error(`${name} not found`);
  const end = src.indexOf('\n];', start);
  return src.slice(start, end + 3);
}

global.esc = (value) => String(value ?? '').replace(/[&<>"]/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
})[char]);
global.localStorage = undefined; // the plain-node harness has no browser storage
global.renderFlag = (key, dflt) => (global.FLAGS && key in global.FLAGS ? global.FLAGS[key] : dflt);
global.inboxRoute = (filter) => `/personal/inbox${filter && filter !== 'all' ? `/${filter}` : ''}`;
global.S = { inbox: [], inboxFilter: 'all', meta: { deliveryChannels: ['browser'] }, deliveryPreferences: null };

// A `const` inside a direct eval stays in the eval's own scope; hoist it out.
eval(extractConst('INBOX_TABS').replace('const INBOX_TABS =', 'global.INBOX_TABS ='));
for (const name of ['inboxShowRead', 'inboxItems', 'inboxTabs', 'inboxRowLabel', 'inboxView']) eval(extractFn(name));

let pass = 0;
let fail = 0;
const ok = (condition, message) => condition ? pass++ : (fail++, console.error('FAIL:', message));

const item = (id, kind, unread, extra = {}) => ({ id, kind, unread, actionable: kind !== 'update',
  taskId: `task_${id}`, createdAt: 1_700_000_000_000, task: { id: `task_${id}`, num: Number(id), title: `Task ${id}`, projectId: 'project_1' }, ...extra });

S.inbox = [
  item('1', 'approval-requested', true),
  item('2', 'review-requested', true),
  item('3', 'review-requested', false),
  item('4', 'update', false),
];

// Show read is OFF by default: an answered notification stops taking up space.
ok(inboxShowRead() === false, 'read items are hidden by default');
ok(inboxItems().map((x) => x.id).join(',') === '1,2', 'only unread items render by default');
global.FLAGS = { 'karmax-inbox-show-read': true };
ok(inboxItems().map((x) => x.id).join(',') === '1,2,3,4', 'the toggle brings read items back');
global.FLAGS = {};

// Sub-tabs classify by kind, and only kinds actually present get a tab.
const tabs = inboxTabs();
ok(tabs[0].key === 'all', 'All is the first sub-tab');
ok(tabs.map((t) => t.key).join(',') === 'all,approval-requested,review-requested,update',
  `only kinds present get a tab (got ${tabs.map((t) => t.key).join(',')})`);
ok(tabs.find((t) => t.key === 'review-requested').unread === 1, 'a sub-tab counts its UNREAD items');
ok(tabs.find((t) => t.key === 'all').unread === 2, 'All counts every unread item');

S.inboxFilter = 'approval-requested';
ok(inboxItems().map((x) => x.id).join(',') === '1', 'the selected sub-tab filters the list');
S.inboxFilter = 'escalated'; // a filter whose items have all been answered
ok(inboxItems().length === 0, 'an empty sub-tab simply renders empty');
S.inboxFilter = 'all';

// An update's news is the outcome, not the word "update".
ok(inboxRowLabel(item('9', 'update', true, { task: { status: 'cancelled' } })) === 'cancelled',
  'an update row names the outcome it reports');
ok(inboxRowLabel(item('9', 'update', true)) === 'update', 'and falls back when the status is unknown');
ok(inboxRowLabel(item('9', 'review-requested', true)) === 'review requested', 'an ask names itself');

const html = inboxView();
ok(html.includes('href="/personal/inbox/approval-requested"'), 'sub-tabs are real links (URL owns the view)');
ok(html.includes('id="inbox-show-read"'), 'the panel offers the Show read toggle');
ok(!/id="inbox-show-read"[^>]*checked/.test(html), 'Show read is unchecked by default');
ok(html.includes('Task 1'), 'rows render the task title');
ok(!html.includes('Task 3'), 'a read row is not rendered while Show read is off');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
