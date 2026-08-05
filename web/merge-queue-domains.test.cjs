// The merge queue reads `mergeDomains` (plural), not `mergeDomain` (singular).
//
// A multi-repo task takes ONE MERGE SLOT PER REPO, so the plural is the truth and
// the singular is only ever its first entry. Keying the panel on the singular had
// two consequences:
//   · a multi-repo task appeared in — and could be reordered within — only its
//     first repo's queue;
//   · a MERGE-ONLY task, which publishes only the plural, fell into the unnamed
//     `''` group. It still RENDERED (so "invisible" would be the wrong word for
//     it) but with no domain label, no drag handle, no reorder buttons and no
//     coordinator order fetched — present but inert, which is the worse of the
//     two failures because nothing looks wrong.
// The assertions below therefore check that a merge-only task lands in its REAL
// domain and is actually operable, not merely that it appears somewhere.
// Run: node web/merge-queue-domains.test.cjs
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

let pass = 0;
let fail = 0;
const ok = (condition, message) => condition ? pass++ : (fail++, console.error('FAIL:', message));

global.esc = (s) => String(s == null ? '' : s);
eval(extractFn('taskMergeDomains'));
eval(extractFn('queueRank'));
eval(extractFn('mergeQueuePanel'));

// ── the helper ───────────────────────────────────────────────────────────────
ok(JSON.stringify(taskMergeDomains({ state: { mergeDomains: ['app:main', 'wiki:main'] } })) === '["app:main","wiki:main"]',
  'the plural is authoritative when present');
ok(JSON.stringify(taskMergeDomains({ state: { mergeDomain: 'app:main' } })) === '["app:main"]',
  'the singular is still honoured for views published before the plural existed');
ok(JSON.stringify(taskMergeDomains({ state: { mergeDomains: ['a'], mergeDomain: 'a' } })) === '["a"]',
  'a view carrying both is not double-counted');
ok(JSON.stringify(taskMergeDomains({ state: {} })) === '[]', 'no domain yet ⇒ none');
ok(JSON.stringify(taskMergeDomains(undefined)) === '[]', 'a task with no view does not throw');

// ── the panel ────────────────────────────────────────────────────────────────
const view = (over) => ({ stage: 'merge', branch: 'b', targetBranch: 'main', ...over });
global.S = {
  queueOrders: {},
  tasks: [
    // A merge-only task: publishes ONLY the plural. This is the one that vanished.
    { id: 'mo', num: 7, title: 'Merge only', lastView: view({ state: { mergeDomains: ['app:main'] } }) },
    // A multi-repo software-dev task: holds two slots, so it belongs in both lists.
    { id: 'multi', num: 8, title: 'Two repos', lastView: view({ state: { mergeDomain: 'app:main', mergeDomains: ['app:main', 'wiki:main'] } }) },
  ],
};

const html = mergeQueuePanel();
// Discriminating checks for the merge-only case: it always rendered SOMEWHERE,
// so only its domain grouping and operability actually prove the fix.
// Read the merge-only row's OWN opening tag rather than a byte window around it —
// a fixed-size slice bleeds into the next group and silently stops discriminating.
const moTag = (html.match(/<div class="queue-item[^>]*data-id="mo"[^>]*>/) || [''])[0];
ok(html.includes('Merge only'), 'a merge-only task appears in the merge queue');
ok(!/data-domain=""/.test(html), 'no task is stranded in the unnamed domain group');
ok(/data-domain="app:main"/.test(moTag), 'a merge-only task is grouped under its REAL domain');
ok(/draggable="true"/.test(moTag), 'a merge-only task can be dragged, not just displayed');
ok(html.includes('Two repos'), 'a multi-repo task appears in the merge queue');
ok((html.match(/Two repos/g) || []).length === 2, 'a task holding two domains is listed once per domain');
ok(html.includes('data-domain="app:main"'), 'the app domain is rendered');
ok(html.includes('data-domain="wiki:main"'), 'the SECOND repo domain is rendered too');
// Reorder controls must be offered in each domain, since each is a real queue.
const wikiSlice = html.slice(html.indexOf('data-domain="wiki:main"'));
ok(wikiSlice.includes('data-move="top"'), 'the second domain is reorderable, not read-only');

// A task that is merging pins to the top of its domain and cannot be dragged.
global.S.tasks = [
  { id: 'a', num: 1, title: 'Queued', lastView: view({ state: { mergeDomains: ['d'] } }) },
  { id: 'b', num: 2, title: 'Merging', lastView: view({ state: { mergeDomains: ['d'], mergeGranted: true } }) },
];
const pinned = mergeQueuePanel();
ok(pinned.indexOf('Merging') < pinned.indexOf('Queued'), 'the leased task sorts first');
ok(pinned.includes('class="queue-item current"'), 'the leased task is marked as merging');

// Once GitHub owns the durable queue, the task remains observable but is no
// longer presented as reorderable in karmax's admission queue.
global.S.tasks = [
  { id: 'provider', num: 3, title: 'Provider owned', lastView: view({
    state: {}, landing: { provider: 'validating', detail: 'running merge-group CI' },
  }) },
];
const provider = mergeQueuePanel();
ok(provider.includes('GitHub landing queue'), 'provider-owned entries get their own clearly labelled queue');
ok(provider.includes('GitHub validating'), 'the provider validation state is visible');
ok(!provider.includes('draggable="true"'), 'provider-owned order cannot be changed through the karmax coordinator');
ok(!provider.includes('data-domain=""'), 'provider-owned entries are not placed in the unnamed internal queue');

// An empty queue still reads as empty, not as a stray group.
global.S.tasks = [];
ok(mergeQueuePanel().includes('Merge queue is empty'), 'no tasks ⇒ the empty state');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
