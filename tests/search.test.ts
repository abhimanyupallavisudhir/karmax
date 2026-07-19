import { describe, it, expect, beforeEach } from 'vitest';
import { Store } from '../src/store/db.js';
import { parseQuery, stringifyQuery } from '../src/domain/query-language.js';
import { evaluateQuery, fieldCatalogue, resolveTagValue, SearchTask } from '../src/domain/search.js';
import { Tag, TaskRecord } from '../src/domain/types.js';

// ── fixtures ──────────────────────────────────────────────────────────────────
// A hand-built task shaped like the store's hydrated record: the stored fields plus
// a `lastView` (status/stage/pr live there) and a `tags` id list.
const DAY = 86400e3;
const NOW = Date.UTC(2026, 6, 9); // fixed clock so date filters are deterministic

function task(over: { title: string } & Record<string, any>): SearchTask {
  return {
    id: over.title.toLowerCase().replace(/\W+/g, '-'),
    projectId: 'p1',
    listId: 'l1',
    workflow: 'softwareDev',
    workflowVersion: '1.0.0',
    params: {},
    createdAt: NOW,
    order: 0,
    ...over,
  } as SearchTask;
}

function view(status: string, stage = 'do', extra: Record<string, unknown> = {}) {
  return { status, stage, updatedAt: NOW, ...extra } as any;
}

describe('query-language parser', () => {
  it('parses enum, negation, comma-OR, comparisons, dates, facets, free text', () => {
    const q = parseQuery('status:active,waiting -tag:bug priority:>=2 created:<7d is:open hello "two words"');
    expect(q.filters).toEqual([
      { field: 'status', op: 'is', values: ['active', 'waiting'] },
      { field: 'tag', op: 'is', values: ['bug'], negate: true },
      { field: 'priority', op: 'gte', values: ['2'] },
      { field: 'created', op: 'lt', values: ['7d'] },
      { field: 'is', op: 'is', values: ['open'] },
    ]);
    expect(q.text).toBe('hello two words');
  });

  it('parses sort and group directives', () => {
    const q = parseQuery('sort:priority-desc sort:-created group:status');
    expect(q.sort).toEqual([
      { field: 'priority', dir: 'desc' },
      { field: 'created', dir: 'desc' },
    ]);
    expect(q.group).toBe('status');
  });

  it('resolves aliases (label→tag, id→num) to canonical field keys', () => {
    expect(parseQuery('label:frontend').filters?.[0]?.field).toBe('tag');
    expect(parseQuery('id:>=3').filters?.[0]).toEqual({ field: 'num', op: 'gte', values: ['3'] });
  });

  it('keeps quoted multi-word clause values together (the form stringifyQuery emits)', () => {
    expect(parseQuery('conversation:"merge conflict"').filters).toEqual([
      { field: 'conversation', op: 'contains', values: ['merge conflict'] },
    ]);
    // commas outside quotes still split; quoted parts keep their spaces
    expect(parseQuery('status:done,"in progress"').filters).toEqual([
      { field: 'status', op: 'is', values: ['done', 'in progress'] },
    ]);
    // negation composes, and the quoted value is literal (no op sniffing inside)
    expect(parseQuery('-says:">boom"').filters).toEqual([
      { field: 'conversation', op: 'contains', values: ['>boom'], negate: true },
    ]);
  });

  it('round-trips a spaced clause value through stringifyQuery', () => {
    const q = parseQuery('conversation:"artifact cache" is:open');
    expect(parseQuery(stringifyQuery(q))).toEqual(q);
  });

  it('treats an unknown field key as free text (never drops it)', () => {
    const q = parseQuery('bogus:value plain');
    expect(q.filters).toBeUndefined();
    expect(q.text).toBe('bogus:value plain');
  });

  it('round-trips through stringifyQuery', () => {
    const s = 'status:active -tag:bug priority:>=2 sort:created-desc group:status needle';
    const q = parseQuery(s);
    // Re-parsing the stringified form yields the same structured query.
    expect(parseQuery(stringifyQuery(q))).toEqual(q);
  });
});

describe('evaluateQuery — filtering', () => {
  const tasks: SearchTask[] = [
    task({ title: 'Fix login bug', num: 1, lastView: view('active'), tags: ['t-bug'], params: { priority: 3 } }),
    task({ title: 'Add dashboard', num: 2, lastView: view('done'), tags: ['t-feat', 't-frontend'], params: { priority: 1 } }),
    task({ title: 'Refactor auth', num: 3, lastView: view('active'), tags: ['t-auth'], params: { priority: 0 } }),
    task({ title: 'Waiting on review', num: 4, lastView: view('waiting', 'review'), tags: [] }),
  ];
  const ctx = { now: NOW, tags: [] as Tag[] };

  it('filters by enum (status), OR within a clause', () => {
    const r = evaluateQuery(tasks, parseQuery('status:active,waiting'), ctx);
    expect(r.tasks.map((t) => t.num).sort()).toEqual([1, 3, 4]);
  });

  it('negates a clause', () => {
    const r = evaluateQuery(tasks, parseQuery('-status:done'), ctx);
    expect(r.tasks.map((t) => t.num).sort()).toEqual([1, 3, 4]);
  });

  it('filters by numeric priority with a comparison op', () => {
    expect(evaluateQuery(tasks, parseQuery('priority:>=2'), ctx).tasks.map((t) => t.num)).toEqual([1]);
  });

  it('accepts named priority levels', () => {
    expect(evaluateQuery(tasks, parseQuery('priority:high'), ctx).tasks.map((t) => t.num)).toEqual([1]);
  });

  it('matches facets (is:open / is:untagged)', () => {
    expect(evaluateQuery(tasks, parseQuery('is:open'), ctx).tasks.map((t) => t.num).sort()).toEqual([1, 3, 4]);
    expect(evaluateQuery(tasks, parseQuery('is:untagged'), ctx).tasks.map((t) => t.num)).toEqual([4]);
  });

  it('searches responsibility and caller-relative work/review facets', () => {
    const owned = task({ title: 'Owned', num: 20, assignee: { kind: 'user', userId: 'u1' },
      createdBy: { kind: 'user', userId: 'u2' }, subscribers: [{ kind: 'team', teamId: 'design' }],
      lastView: view('active') });
    const review = task({ title: 'Review', num: 21, reviewers: ['u1'], lastView: view('waiting', 'review') });
    const other = task({ title: 'Other', num: 22, assignee: { kind: 'user', userId: 'u2' }, lastView: view('active') });
    const mine = { ...ctx, userId: 'u1' };
    expect(evaluateQuery([owned, review, other], parseQuery('is:mine'), mine).tasks.map((t) => t.num)).toEqual([20]);
    expect(evaluateQuery([owned, review, other], parseQuery('needs:my-review'), mine).tasks.map((t) => t.num)).toEqual([21]);
    expect(evaluateQuery([owned, review, other], parseQuery('is:unassigned'), mine).tasks.map((t) => t.num)).toEqual([21]);
    expect(evaluateQuery([owned, review, other], parseQuery('creator:user:u2'), mine).tasks.map((t) => t.num)).toEqual([20]);
    expect(evaluateQuery([owned, review, other], parseQuery('participant:team:design'), mine).tasks.map((t) => t.num)).toEqual([20]);
  });

  it('AND-s multiple clauses together', () => {
    const r = evaluateQuery(tasks, parseQuery('status:active priority:>=1'), ctx);
    expect(r.tasks.map((t) => t.num)).toEqual([1]);
  });

  it('runs free-text over title and #num', () => {
    expect(evaluateQuery(tasks, parseQuery('auth'), ctx).tasks.map((t) => t.num)).toEqual([3]);
    expect(evaluateQuery(tasks, parseQuery('#2'), ctx).tasks.map((t) => t.num)).toEqual([2]);
  });
});

describe('evaluateQuery — free text (token-AND over title/notes/prompt/#num)', () => {
  const tasks: SearchTask[] = [
    task({ title: 'Fix login bug', num: 1, notes: 'affects the web client' }),
    task({ title: 'Add login rate limit', num: 2 }),
    task({ title: 'Refactor auth', num: 3 }),
    // A boilerplate preamble becomes the title; the real subject lives only in the prompt.
    task({ title: '[STANDING INSTRUCTION. My requests are APPROXIMATE…', num: 4, params: { prompt: '[STANDING INSTRUCTION…]\n\nkarmax needs a wiki system for agent skills' } }),
  ];
  const ctx = { now: NOW, tags: [] as Tag[] };

  it('requires every term (order-independent), not the contiguous phrase', () => {
    // "login fix" matches "Fix login bug" even though the words are reordered.
    expect(evaluateQuery(tasks, parseQuery('login fix'), ctx).tasks.map((t) => t.num)).toEqual([1]);
    expect(evaluateQuery(tasks, parseQuery('login'), ctx).tasks.map((t) => t.num).sort()).toEqual([1, 2]);
  });

  it('matches across title AND notes', () => {
    expect(evaluateQuery(tasks, parseQuery('web'), ctx).tasks.map((t) => t.num)).toEqual([1]);
    // one term in the title, one in the notes → still a hit
    expect(evaluateQuery(tasks, parseQuery('fix web'), ctx).tasks.map((t) => t.num)).toEqual([1]);
  });

  it('matches the task number as a term', () => {
    expect(evaluateQuery(tasks, parseQuery('#3'), ctx).tasks.map((t) => t.num)).toEqual([3]);
  });

  it('matches words that appear only in the prompt (titles are just its first line)', () => {
    expect(evaluateQuery(tasks, parseQuery('wiki'), ctx).tasks.map((t) => t.num)).toEqual([4]);
    // terms may straddle title and prompt
    expect(evaluateQuery(tasks, parseQuery('standing wiki'), ctx).tasks.map((t) => t.num)).toEqual([4]);
  });

  it('supports an explicit prompt: filter distinct from title', () => {
    expect(evaluateQuery(tasks, parseQuery('prompt:wiki'), ctx).tasks.map((t) => t.num)).toEqual([4]);
    expect(evaluateQuery(tasks, parseQuery('-prompt:wiki login'), ctx).tasks.map((t) => t.num).sort()).toEqual([1, 2]);
  });
});

describe('evaluateQuery — conversation: filter (opt-in transcript search)', () => {
  const tasks: SearchTask[] = [
    task({
      title: 'Fix flaky deploy', num: 1,
      lastView: view('waiting', 'review', {
        messages: [{ id: 'm0', role: 'user', text: 'the deploy is flaky', ts: 0 }],
        transcripts: [
          { role: 'do', label: 'Do agent', messages: [
            { id: 'm0', role: 'user', text: 'the deploy is flaky', ts: 0 },
            { id: 'a1', role: 'agent', text: 'Root cause: a stale artifact cache; purged it.', ts: 1 },
          ] },
          { role: 'merge', label: 'Merge agent', messages: [
            { id: 'a2', role: 'agent', text: 'Resolved a rebase conflict in ci.yml', ts: 2 },
          ] },
        ],
      }),
    }),
    // No transcripts — the legacy top-level `messages` (the Do transcript) is the fallback.
    task({ title: 'Old-style task', num: 2, lastView: view('done', 'done', { messages: [{ id: 'm0', role: 'user', text: 'tune the artifact retention', ts: 0 }] }) }),
    // Never started — no lastView at all; must simply not match.
    task({ title: 'Untouched draft', num: 3 }),
  ];
  const ctx = { now: NOW, tags: [] as Tag[] };

  it('matches text from any role transcript, with the says: alias and negation', () => {
    expect(evaluateQuery(tasks, parseQuery('conversation:"artifact cache"'), ctx).tasks.map((t) => t.num)).toEqual([1]);
    expect(evaluateQuery(tasks, parseQuery('says:conflict'), ctx).tasks.map((t) => t.num)).toEqual([1]);
    expect(evaluateQuery(tasks, parseQuery('-conversation:artifact'), ctx).tasks.map((t) => t.num)).toEqual([3]);
  });

  it('falls back to the legacy messages transcript and skips tasks with no view', () => {
    expect(evaluateQuery(tasks, parseQuery('conversation:retention'), ctx).tasks.map((t) => t.num)).toEqual([2]);
    expect(evaluateQuery(tasks, parseQuery('conversation:anything'), ctx).tasks.map((t) => t.num)).toEqual([]);
  });

  it('keeps bare free-text away from transcripts (precision guarantee)', () => {
    // "conflict" lives only in the merge transcript — bare text must NOT find it.
    expect(evaluateQuery(tasks, parseQuery('conflict'), ctx).tasks.map((t) => t.num)).toEqual([]);
  });
});

describe('evaluateQuery — per-role agent/model params (agent_<role>.<sub>)', () => {
  const tasks: SearchTask[] = [
    task({ title: 'A', num: 1, params: { prompt: 'a', do: { provider: 'claude', model: 'claude-opus-4-8', effort: 'high' }, merge: { provider: 'codex' } } as any }),
    task({ title: 'B', num: 2, params: { prompt: 'b', do: { provider: 'codex', model: 'gpt-5', effort: 'low' } } as any }),
  ];
  const ctx = { now: NOW, tags: [] as Tag[] };

  it('filters by the provider (agent), model, and effort of a role', () => {
    expect(evaluateQuery(tasks, parseQuery('agent_do.agent:claude'), ctx).tasks.map((t) => t.num)).toEqual([1]);
    expect(evaluateQuery(tasks, parseQuery('agent_do.model:gpt-5'), ctx).tasks.map((t) => t.num)).toEqual([2]);
    expect(evaluateQuery(tasks, parseQuery('agent_do.effort:high'), ctx).tasks.map((t) => t.num)).toEqual([1]);
    expect(evaluateQuery(tasks, parseQuery('agent_merge.agent:codex'), ctx).tasks.map((t) => t.num)).toEqual([1]);
  });

  it('groups and sorts by a role model', () => {
    const g = evaluateQuery(tasks, parseQuery('group:agent_do.agent'), ctx);
    expect(g.groups?.map((x) => x.label).sort()).toEqual(['claude', 'codex']);
    const s = evaluateQuery(tasks, parseQuery('sort:agent_do.model-asc'), ctx);
    expect(s.tasks.map((t) => t.num)).toEqual([1, 2]); // claude-opus… < gpt-5
  });
});

describe('evaluateQuery — hierarchical tags', () => {
  // frontend/ web, mobile ; a task tagged with a child matches a parent-tag filter.
  const catalog: Tag[] = [
    { id: 'front', projectId: 'p1', name: 'frontend', kind: 'topic', createdAt: NOW },
    { id: 'web', projectId: 'p1', name: 'web', parentId: 'front', kind: 'topic', createdAt: NOW },
    { id: 'mobile', projectId: 'p1', name: 'mobile', parentId: 'front', kind: 'topic', createdAt: NOW },
    { id: 'bug', projectId: 'p1', name: 'bug', kind: 'type', createdAt: NOW },
  ];
  const tasks: SearchTask[] = [
    task({ title: 'web task', num: 1, tags: ['web'] }),
    task({ title: 'mobile task', num: 2, tags: ['mobile'] }),
    task({ title: 'bug task', num: 3, tags: ['bug'] }),
  ];
  const ctx = { now: NOW, tags: catalog };

  it('resolves a parent tag to itself + all descendants', () => {
    expect(resolveTagValue('frontend', catalog)).toEqual(new Set(['front', 'web', 'mobile']));
  });

  it('selecting a parent tag matches tasks tagged with a child', () => {
    expect(evaluateQuery(tasks, parseQuery('tag:frontend'), ctx).tasks.map((t) => t.num).sort()).toEqual([1, 2]);
  });

  it('resolves a slash path (frontend/web)', () => {
    expect(evaluateQuery(tasks, parseQuery('tag:frontend/web'), ctx).tasks.map((t) => t.num)).toEqual([1]);
  });
});

describe('evaluateQuery — dates', () => {
  const tasks: SearchTask[] = [
    task({ title: 'old', num: 1, createdAt: NOW - 30 * DAY }),
    task({ title: 'recent', num: 2, createdAt: NOW - 2 * DAY }),
    task({ title: 'today', num: 3, createdAt: NOW - 1000 }),
  ];
  const ctx = { now: NOW, tags: [] as Tag[] };

  it('relative age: created:<7d = newer than 7 days', () => {
    expect(evaluateQuery(tasks, parseQuery('created:<7d'), ctx).tasks.map((t) => t.num).sort()).toEqual([2, 3]);
  });

  it('relative age: created:>7d = older than 7 days', () => {
    expect(evaluateQuery(tasks, parseQuery('created:>7d'), ctx).tasks.map((t) => t.num)).toEqual([1]);
  });
});

describe('evaluateQuery — sort and group', () => {
  const tasks: SearchTask[] = [
    task({ title: 'B', num: 1, lastView: view('active'), params: { priority: 1 }, createdAt: NOW - DAY }),
    task({ title: 'A', num: 2, lastView: view('done'), params: { priority: 3 }, createdAt: NOW - 2 * DAY }),
    task({ title: 'C', num: 3, lastView: view('active'), params: { priority: 3 }, createdAt: NOW }),
  ];
  const ctx = { now: NOW, tags: [] as Tag[] };

  it('sorts by priority desc, tie-broken by a secondary clause', () => {
    const r = evaluateQuery(tasks, parseQuery('sort:priority-desc sort:num-asc'), ctx);
    expect(r.tasks.map((t) => t.num)).toEqual([2, 3, 1]);
  });

  it('defaults to created desc when no sort given', () => {
    expect(evaluateQuery(tasks, parseQuery(''), ctx).tasks.map((t) => t.num)).toEqual([3, 1, 2]);
  });

  it('groups by status and orders groups by natural option order', () => {
    const r = evaluateQuery(tasks, parseQuery('group:status'), ctx);
    expect(r.groups?.map((g) => g.key)).toEqual(['active', 'done']);
    expect(r.groups?.find((g) => g.key === 'active')?.count).toBe(2);
  });
});

describe('fieldCatalogue', () => {
  it('exposes groupable/sortable flags the UI menus read', () => {
    const cat = fieldCatalogue();
    const status = cat.find((f) => f.key === 'status')!;
    expect(status.groupable).toBe(true);
    expect(status.options?.map((o) => o.value)).toContain('active');
    expect(cat.find((f) => f.key === 'stage')!.options?.map((o) => o.value)).not.toContain('resolve');
    expect(cat.find((f) => f.key === 'title')!.sortable).toBe(true);
  });

  it('surfaces the trigger fields + facets the UI/agents organize by', () => {
    const cat = fieldCatalogue();
    expect(cat.find((f) => f.key === 'trigger')!.groupable).toBe(true);
    expect(cat.find((f) => f.key === 'nextRun')!.sortable).toBe(true);
    expect(cat.find((f) => f.key === 'dependsOn')).toBeTruthy();
    const facets = cat.find((f) => f.key === 'is')!.options!.map((o) => o.value);
    expect(facets).toEqual(expect.arrayContaining(['armed', 'scheduled', 'recurring', 'blocked-on-deps', 'series', 'run']));
    expect(cat.find((f) => f.key === 'status')!.options!.map((o) => o.value)).toContain('armed');
  });
});

// ── trigger-aware search (dependencies, cron/schedules, repeatable series) ─────
describe('evaluateQuery — triggers, schedules, series', () => {
  const CRON = '0 9 * * *'; // 09:00 UTC daily
  const ctx = { now: NOW, tags: [] as Tag[] };
  const armedSchedule = (title: string, num: number) =>
    task({ title, num, params: { prompt: 'x', triggers: [{ kind: 'schedule', cron: CRON }], triggerState: 'armed', repeatable: true } as any });

  it('reports an armed (trigger-gated, never-started) task as status "armed", not "active"', () => {
    const t = armedSchedule('nightly', 1);
    expect(evaluateQuery([t], parseQuery('status:armed'), ctx).tasks.map((x) => x.num)).toEqual([1]);
    expect(evaluateQuery([t], parseQuery('status:active'), ctx).total).toBe(0);
    // …but once it has fired and started (has a lastView), its real status wins.
    const started = task({ title: 'nightly', num: 1, lastView: view('active'), params: { prompt: 'x', triggers: [{ kind: 'schedule', cron: CRON }], triggerState: 'fired' } as any });
    expect(evaluateQuery([started], parseQuery('status:active'), ctx).total).toBe(1);
  });

  it('matches trigger/series facets', () => {
    const sched = armedSchedule('nightly', 1);
    const dep = task({ title: 'after-A', num: 2, params: { prompt: 'x', triggers: [{ kind: 'dependency', tasks: ['task-a'] }], triggerState: 'armed' } as any });
    const run = task({ title: 'run-7', num: 3, lastView: view('done'), params: { prompt: 'x', runOf: 'series-1' } as any });
    const plain = task({ title: 'plain', num: 4, lastView: view('active') });
    const all = [sched, dep, run, plain];
    const nums = (q: string) => evaluateQuery(all, parseQuery(q), ctx).tasks.map((t) => t.num).sort();
    expect(nums('is:scheduled')).toEqual([1]);
    expect(nums('is:recurring')).toEqual([1]); // cron ⇒ recurring (also repeatable)
    expect(nums('is:blocked-on-deps')).toEqual([2]);
    expect(nums('is:armed')).toEqual([1, 2]);
    expect(nums('is:triggered')).toEqual([1, 2]);
    expect(nums('is:series')).toEqual([1]); // repeatable template
    expect(nums('is:run')).toEqual([3]);
    expect(nums('-is:triggered')).toEqual([3, 4]);
  });

  it('groups by trigger kind and searches the cron text', () => {
    const sched = armedSchedule('nightly', 1);
    const dep = task({ title: 'after-A', num: 2, params: { prompt: 'x', triggers: [{ kind: 'dependency', tasks: ['task-a'] }], triggerState: 'armed' } as any });
    const plain = task({ title: 'plain', num: 3, lastView: view('active') });
    const g = evaluateQuery([sched, dep, plain], parseQuery('group:trigger'), ctx);
    expect(g.groups?.map((x) => x.key).sort()).toEqual(['dependency', 'none', 'schedule']);
    // `schedule:` matches the cron text (only the cron task has one); `is:scheduled` is the facet.
    expect(evaluateQuery([sched, dep, plain], parseQuery('schedule:9'), ctx).tasks.map((t) => t.num)).toEqual([1]);
  });

  it('computes + sorts by nextRun (soonest first with sort:nextRun-asc)', () => {
    const morning = task({ title: 'morning', num: 1, params: { prompt: 'x', triggers: [{ kind: 'schedule', cron: '0 9 * * *' }], triggerState: 'armed' } as any });
    const earlier = task({ title: 'earlier', num: 2, params: { prompt: 'x', triggers: [{ kind: 'schedule', cron: '0 6 * * *' }], triggerState: 'armed' } as any });
    const r = evaluateQuery([morning, earlier], parseQuery('is:scheduled sort:nextRun-asc'), ctx);
    expect(r.tasks.map((t) => t.num)).toEqual([2, 1]); // 06:00 fires before 09:00
  });

  it('makes the dependency graph queryable (dependsOn / blocks by #num)', () => {
    const a = task({ title: 'build', num: 1, lastView: view('active') });
    const b = task({ title: 'deploy', num: 2, params: { prompt: 'x', triggers: [{ kind: 'dependency', tasks: [a.id] }], triggerState: 'armed' } as any });
    const all = [a, b];
    // "what is waiting on #1?" → the deploy task depends on build
    expect(evaluateQuery(all, parseQuery('dependsOn:#1'), ctx).tasks.map((t) => t.num)).toEqual([2]);
    // "what blocks #2?" → the build task
    expect(evaluateQuery(all, parseQuery('blocks:#2'), ctx).tasks.map((t) => t.num)).toEqual([1]);
    // by raw id too
    expect(evaluateQuery(all, parseQuery(`dependsOn:${a.id}`), ctx).tasks.map((t) => t.num)).toEqual([2]);
  });
});

describe('evaluateQuery — workflow params (param.<key>)', () => {
  const tasks: SearchTask[] = [
    task({ title: 'A', num: 1, params: { prompt: 'a', base: 'main', target: 'main' } as any }),
    task({ title: 'B', num: 2, params: { prompt: 'b', base: 'develop', target: 'main' } as any }),
    task({ title: 'C', num: 3, params: { prompt: 'c', target: 'release' } as any }),
  ];
  const ctx = { now: NOW, tags: [] as Tag[] };

  it('filters by an arbitrary param key (contains match)', () => {
    expect(evaluateQuery(tasks, parseQuery('param.base:develop'), ctx).tasks.map((t) => t.num)).toEqual([2]);
  });

  it('supports the p.<key> shorthand', () => {
    expect(evaluateQuery(tasks, parseQuery('p.target:main'), ctx).tasks.map((t) => t.num).sort()).toEqual([1, 2]);
  });

  it('groups by a param key, bucketing the missing value under None', () => {
    const r = evaluateQuery(tasks, parseQuery('group:param.base'), ctx);
    const keys = r.groups?.map((g) => g.label).sort();
    expect(keys).toEqual(['None', 'develop', 'main']);
  });

  it('sorts by a param key', () => {
    const r = evaluateQuery(tasks, parseQuery('sort:param.target-asc'), ctx);
    expect(r.tasks.map((t) => t.num)).toEqual([1, 2, 3]); // main, main, release
  });
});

// ── store CRUD (in-memory sqlite; no Temporal) ─────────────────────────────────
describe('Store — tags', () => {
  let store: Store;
  let pid: string;
  beforeEach(() => {
    store = new Store(':memory:');
    pid = store.createProject('Acme').id;
  });

  const mkTask = (title: string): TaskRecord =>
    store.createTask({ projectId: pid, title, workflow: 'softwareDev', workflowVersion: '1.0.0', params: { prompt: title } });

  it('creates, dedups by name, and lists tags', () => {
    const a = store.createTag({ projectId: pid, name: 'bug', kind: 'type' });
    const b = store.createTag({ projectId: pid, name: 'BUG', kind: 'type' }); // case-insensitive dup
    expect(b.id).toBe(a.id);
    expect(store.listTags(pid).map((t) => t.name)).toEqual(['bug']);
  });

  it('creates a hierarchy from a slash path, reusing existing ancestors', () => {
    const leaf = store.createTag({ projectId: pid, name: 'frontend/web/checkout', kind: 'topic', color: '#f00' });
    expect(leaf.name).toBe('checkout');
    expect(leaf.color).toBe('#f00'); // color applies to the leaf only
    const names = store.listTags(pid).map((t) => t.name).sort();
    expect(names).toEqual(['checkout', 'frontend', 'web']);
    // A second path reuses frontend + web rather than duplicating them.
    const other = store.createTag({ projectId: pid, name: 'frontend/web/cart' });
    expect(store.getTag(other.parentId!)!.name).toBe('web');
    expect(store.listTags(pid).filter((t) => t.name === 'web')).toHaveLength(1);
    // The path resolves the full chain.
    const byId = new Map(store.listTags(pid).map((t) => [t.id, t]));
    const path = (id: string) => { const p: string[] = []; let c = byId.get(id); while (c) { p.unshift(c.name); c = c.parentId ? byId.get(c.parentId) : undefined; } return p.join('/'); };
    expect(path(leaf.id)).toBe('frontend/web/checkout');
  });

  it('assigns tags to a task and hydrates them on read', () => {
    const t = mkTask('x');
    const bug = store.createTag({ projectId: pid, name: 'bug' });
    const fe = store.createTag({ projectId: pid, name: 'frontend' });
    store.setTaskTags(t.id, [bug.id, fe.id]);
    expect(store.getTask(t.id)!.tags!.sort()).toEqual([bug.id, fe.id].sort());
    expect(store.listTasks(pid)[0]!.tags!.length).toBe(2);
  });

  it('ignores foreign/unknown tag ids on assignment', () => {
    const t = mkTask('x');
    store.setTaskTags(t.id, ['tag_does_not_exist']);
    expect(store.getTask(t.id)!.tags ?? []).toEqual([]);
  });

  it('deleting a tag promotes children to its parent and drops assignments', () => {
    const parent = store.createTag({ projectId: pid, name: 'frontend' });
    const child = store.createTag({ projectId: pid, name: 'web', parentId: parent.id });
    const t = mkTask('x');
    store.setTaskTags(t.id, [parent.id]);
    store.deleteTag(parent.id);
    expect(store.getTag(child.id)!.parentId).toBeUndefined(); // promoted to root
    expect(store.getTask(t.id)!.tags ?? []).toEqual([]); // assignment dropped
  });

  it('refuses to reparent a tag under its own descendant', () => {
    const a = store.createTag({ projectId: pid, name: 'a' });
    const b = store.createTag({ projectId: pid, name: 'b', parentId: a.id });
    expect(() => store.updateTag(a.id, { parentId: b.id })).toThrow(/ancestor/);
  });
});

describe('Store — saved views', () => {
  let store: Store;
  let pid: string;
  beforeEach(() => {
    store = new Store(':memory:');
    pid = store.createProject('Acme').id;
  });

  it('creates views with increasing order and round-trips the query', () => {
    const q = parseQuery('status:active priority:>=2 sort:created-desc');
    const v1 = store.createView({ projectId: pid, name: 'Active', query: q });
    const v2 = store.createView({ projectId: pid, name: 'Second', query: {} });
    expect(v1.order).toBe(0);
    expect(v2.order).toBe(1);
    expect(store.getView(v1.id)!.query).toEqual(q);
    expect(store.listViews(pid).map((v) => v.name)).toEqual(['Active', 'Second']);
  });

  it('updates and deletes a view', () => {
    const v = store.createView({ projectId: pid, name: 'V', query: {} });
    store.updateView(v.id, { name: 'Renamed', query: parseQuery('is:open') });
    expect(store.getView(v.id)!.name).toBe('Renamed');
    expect(store.getView(v.id)!.query.filters?.[0]?.field).toBe('is');
    store.deleteView(v.id);
    expect(store.getView(v.id)).toBeUndefined();
  });

  it('drops a project’s tags and views when the project is deleted', () => {
    store.createTag({ projectId: pid, name: 'bug' });
    store.createView({ projectId: pid, name: 'V', query: {} });
    store.deleteProject(pid);
    expect(store.listTags(pid)).toEqual([]);
    expect(store.listViews(pid)).toEqual([]);
  });
});
