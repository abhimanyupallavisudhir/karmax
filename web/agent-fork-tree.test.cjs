// Focused checks for the Task overview's agent-fork hierarchy. A source task
// links every direct fork, while forks of those tasks remain nested beneath them.
// Run: node web/agent-fork-tree.test.cjs
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
global.S = {
  tasks: [
    { id: 'source', num: 20, title: 'Original investigation', params: { prompt: 'start' } },
    { id: 'fork-a', num: 21, title: 'Try the first approach', createdAt: 2,
      params: { prompt: 'branch', 'agent:do': { resumeFrom: { taskId: 'source', role: 'do' } } },
      lastView: { stage: 'do', status: 'active' } },
    { id: 'fork-b', num: 22, title: 'Try the second approach', createdAt: 3,
      params: { prompt: 'branch', confirm: { layers: [{ kind: 'agent', resumeFrom: { taskId: 'source', role: 'merge' } }] } },
      lastView: { stage: 'review', status: 'waiting' } },
    { id: 'nested', num: 23, title: 'Refine the first approach', createdAt: 4,
      params: { prompt: 'nested', 'agent:do': { resumeFrom: { taskId: 'fork-a', role: 'do' } } },
      lastView: { stage: 'done', status: 'done' } },
    { id: 'session-only', num: 24, title: 'Continue raw session',
      params: { prompt: 'continue', 'agent:do': { resumeFrom: { sessionId: 'provider-session' } } } },
    { id: 'unrelated', num: 25, title: 'Independent task', params: { prompt: 'other' } },
  ],
};
global.subTaskState = (rec) => ({
  label: rec.lastView?.status === 'done' ? 'Complete' : 'In progress',
  tone: rec.lastView?.status === 'done' ? 'done' : 'active',
});
global.taskUrl = (id) => `/tasks/${id}`;

for (const name of ['taskForkSourceIds', 'agentForkPool', 'agentForkTree', 'subTaskStateHtml', 'agentForksSection']) eval(extractFn(name));

let pass = 0, fail = 0;
const ok = (condition, message) => {
  if (condition) pass++;
  else { fail++; console.error('FAIL:', message); }
};

ok(taskForkSourceIds(S.tasks[1]).includes('source'), 'task agent resumeFrom identifies its source task');
ok(taskForkSourceIds(S.tasks[4]).length === 0, 'a raw provider session is not mistaken for a task fork');

const tree = agentForkTree(agentForkPool({ taskId: 'source' }), 'source');
ok(tree.length === 2, 'only direct forks occupy the top level');
ok(tree[0].task.id === 'fork-a' && tree[0].children[0].task.id === 'nested', 'a recursive fork is nested under its source fork');
ok(tree[1].task.id === 'fork-b' && tree[1].children.length === 0, 'sibling forks stay at the same level');

const panel = agentForksSection({ taskId: 'source' });
ok(panel.includes('Agent forks') && panel.includes('3 task forks'), 'the overview section names and counts the full fork tree');
ok(panel.includes('href="/tasks/fork-a"') && panel.includes('href="/tasks/fork-b"') && panel.includes('href="/tasks/nested"'), 'every fork is a real task link');
ok(panel.indexOf('href="/tasks/nested"') > panel.indexOf('class="fork-tree"', panel.indexOf('href="/tasks/fork-a"')), 'recursive forks render inside a nested tree');
ok(!panel.includes('Continue raw session') && !panel.includes('Independent task'), 'unrelated continuations and tasks stay out of the section');
ok(agentForksSection({ taskId: 'unrelated' }) === '', 'tasks without forks do not show empty overview chrome');

// A finished fork is archived out of the live list; the view's summaries keep it,
// and its own forks stay nested beneath it.
const archived = { taskId: 'source', forkSummaries: [
  { id: 'fork-done', num: 26, title: 'Finished approach', lastView: { stage: 'done', status: 'done' }, forkOf: ['source'] },
  { id: 'fork-done-child', num: 27, title: 'Follow-up on the finished approach', lastView: { stage: 'do', status: 'active' }, forkOf: ['fork-done'] },
  { id: 'fork-a', num: 21, title: 'Stale summary title', lastView: { stage: 'setup', status: 'active' }, forkOf: ['source'] },
] };
const withArchived = agentForksSection(archived);
ok(withArchived.includes('5 task forks'), 'archived forks count alongside live ones');
ok(withArchived.includes('href="/tasks/fork-done"') && withArchived.includes('Complete'), 'a finished fork stays listed as complete');
ok(withArchived.indexOf('href="/tasks/fork-done-child"') > withArchived.indexOf('href="/tasks/fork-done"'), 'a fork of an archived fork nests beneath it');
ok(withArchived.includes('Try the first approach') && !withArchived.includes('Stale summary title'), 'a live record supersedes its summary');
ok(agentForksSection({ taskId: 'archived-only', forkSummaries: [{ id: 'x', title: 'Only fork', lastView: { status: 'done' }, forkOf: ['archived-only'] }] }).includes('1 task fork'),
  'a task whose only fork finished still shows it');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
