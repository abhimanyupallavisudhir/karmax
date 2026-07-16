// Verifies global search's pure cross-project aggregation and ranking.
// Run: node web/global-search.test.cjs
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
function extractFn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0;
  const body = src.indexOf('{', start);
  for (let i = body; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

eval(extractFn('fuzzyScore'));
eval(extractFn('assembleGlobalSearchResults'));

let pass = 0, fail = 0;
const ok = (condition, message) => {
  if (condition) pass++;
  else { fail++; console.error('FAIL:', message); }
};

const alpha = { id: 'alpha', name: 'Alpha workspace' };
const beta = { id: 'beta', name: 'Beta services' };
const titleHit = { id: 't1', title: 'Fix login redirect', createdAt: 10 };
const notesHit = { id: 't2', title: 'Investigate auth', notes: 'login redirect', createdAt: 20 };
const recentStructuredHit = { id: 't3', title: 'Unrelated title', createdAt: 30 };

let found = assembleGlobalSearchResults('login', [alpha, beta], [
  { project: beta, result: { tasks: [notesHit] } },
  { project: alpha, result: { tasks: [titleHit] } },
]);
ok(found.totalTasks === 2, 'merges task matches from every project');
ok(found.taskHits[0].task.id === 't1', 'a title match ranks above a notes-only server match');
ok(found.taskHits[0].project.id === 'alpha', 'keeps project context on each task hit');

found = assembleGlobalSearchResults('login fix', [alpha, beta], [
  { project: beta, result: { tasks: [notesHit] } },
  { project: alpha, result: { tasks: [titleHit] } },
]);
ok(found.taskHits[0].task.id === 't1', 'ranks multi-word title matches independent of word order');

found = assembleGlobalSearchResults('beta', [alpha, beta], []);
ok(found.projectHits.map((hit) => hit.project.id).join() === 'beta', 'finds projects fuzzily by name');

found = assembleGlobalSearchResults('status:active', [alpha, beta], [
  { project: alpha, result: { tasks: [titleHit, recentStructuredHit] } },
]);
ok(found.projectHits.length === 0, 'task filter syntax does not produce misleading project hits');
ok(found.taskHits[0].task.id === 't3', 'structured-query results merge by recency when title relevance is unavailable');

found = assembleGlobalSearchResults('anything', [alpha], [
  { project: alpha, result: { tasks: [titleHit, notesHit, recentStructuredHit] } },
], 2);
ok(found.totalTasks === 3 && found.taskHits.length === 2, 'caps rendered task results while preserving the total');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
