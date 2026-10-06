import { describe, it, expect } from 'vitest';
import { parseQuery, stringifyQuery } from '../src/domain/query-language.js';
import { evaluateQuery, fieldCatalogue, forClauseValues, attentionCandidates, SearchTask } from '../src/domain/search.js';

// `for:<person>` is the "what needs this person" view: the tasks with a live ask
// routed to them (the inbox projection, handed in as `attention`) plus their own
// drafts. `project:` scopes the organization-wide list. Both are pure: the API
// resolves people and projects and passes them in.
const NOW = Date.UTC(2026, 9, 6);

function task(id: string, over: Record<string, any> = {}): SearchTask {
  return {
    id, projectId: 'p1', listId: 'l1', workflow: 'software-dev', workflowVersion: '1.0.0',
    params: {}, createdAt: NOW, order: 0, title: id, lastView: { status: 'active', stage: 'do', updatedAt: NOW },
    ...over,
  } as SearchTask;
}

const alice = 'u_alice', bob = 'u_bob';
const tasks = [
  task('review-me', { lastView: { status: 'waiting', stage: 'review', updatedAt: NOW } }),
  task('input-bob', { lastView: { status: 'waiting', stage: 'do', updatedAt: NOW } }),
  task('my-draft', { params: { draft: true }, createdBy: { kind: 'user', userId: alice } }),
  task('bobs-draft', { params: { draft: true }, createdBy: { kind: 'user', userId: bob } }),
  task('agent-busy'),
  task('child-asks-me', { parentTaskId: 'agent-busy', projectId: 'p2' }),
];
const attention = new Map([
  [alice, new Map([['review-me', ['review-requested']], ['child-asks-me', ['escalated']]])],
  [bob, new Map([['input-bob', ['escalated']], ['review-me', ['mentioned']]])],
]);
const people = new Map([['bob', bob], ['bob@example.com', bob], ['alice', alice]]);
const ctx = { now: NOW, userId: alice, attention, people };
const ids = (q: string, extra: Record<string, unknown> = {}) =>
  evaluateQuery(tasks, parseQuery(q), { ...ctx, ...extra }).tasks.map((t) => t.id).sort();

describe('for: — what needs a person', () => {
  it('parses like any field and round-trips', () => {
    expect(parseQuery('for:me').filters).toEqual([{ field: 'for', op: 'contains', values: ['me'] }]);
    expect(stringifyQuery(parseQuery('-for:"Bob Smith"'))).toBe('-for:"Bob Smith"');
    expect(fieldCatalogue().some((f) => f.key === 'for')).toBe(true);
  });

  it('me = the caller: live asks routed to them plus their own drafts', () => {
    expect(ids('for:me')).toEqual(['child-asks-me', 'my-draft', 'review-me']);
  });

  it('resolves names, emails (case-insensitive) and user:<id>', () => {
    expect(ids('for:Bob')).toEqual(['bobs-draft', 'input-bob', 'review-me']);
    expect(ids('for:BOB@example.com')).toEqual(['bobs-draft', 'input-bob', 'review-me']);
    expect(ids(`for:user:${bob}`)).toEqual(['bobs-draft', 'input-bob', 'review-me']);
    expect(ids('for:me,bob')).toEqual(['bobs-draft', 'child-asks-me', 'input-bob', 'my-draft', 'review-me']);
  });

  it('an unknown person, or me without a signed-in user, matches nothing', () => {
    expect(ids('for:nobody')).toEqual([]);
    expect(ids('for:me', { userId: undefined })).toEqual([]);
    expect(ids('for:me', { attention: undefined })).toEqual(['my-draft']);
  });

  it('negates like other fields', () => {
    expect(ids('-for:me')).toEqual(['agent-busy', 'bobs-draft', 'input-bob']);
  });

  it('explains each row with the reasons of the people asked about', () => {
    const result = evaluateQuery(tasks, parseQuery('for:me'), ctx);
    expect(result.reasons).toEqual({ 'review-me': ['review-requested'], 'child-asks-me': ['escalated'], 'my-draft': ['draft'] });
    expect(evaluateQuery(tasks, parseQuery('-for:me'), ctx).reasons).toBeUndefined();
    expect(evaluateQuery(tasks, parseQuery(''), ctx).reasons).toBeUndefined();
  });

  it('matches an ask raised on the attempt behind a logical task', () => {
    const attempt = task('logical', { intentId: 'logical', id: 'attempt-2' });
    const result = evaluateQuery([attempt], parseQuery('for:me'),
      { ...ctx, attention: new Map([[alice, new Map([['attempt-2', ['review-requested']]])]]) });
    expect(result.tasks).toHaveLength(1);
  });

  it('lists the values to resolve and the candidates a store may narrow to', () => {
    expect(forClauseValues(parseQuery('for:me,"Bob Smith" -for:carol status:active'))).toEqual(['me', 'Bob Smith', 'carol']);
    expect(attentionCandidates(parseQuery('for:me status:waiting'), ctx)).toEqual(new Set(['review-me', 'child-asks-me']));
    // Negated or relational queries need every task.
    expect(attentionCandidates(parseQuery('-for:me'), ctx)).toBeUndefined();
    expect(attentionCandidates(parseQuery('for:me blocks:#3'), ctx)).toBeUndefined();
    expect(attentionCandidates(parseQuery('status:active'), ctx)).toBeUndefined();
  });
});

describe('project: — the organization list filter', () => {
  const projects = new Map([['p1', { name: 'Website Redesign', slug: 'website-redesign' }], ['p2', { name: 'Mobile', slug: 'mobile' }]]);
  it('matches a project id, slug or name, case-insensitively', () => {
    expect(ids('project:p2', { projects })).toEqual(['child-asks-me']);
    expect(ids('project:website-redesign', { projects })).toHaveLength(5);
    expect(ids('project:"website redesign"', { projects })).toHaveLength(5);
    expect(ids('project:MOBILE', { projects })).toEqual(['child-asks-me']);
    expect(ids('-project:mobile', { projects })).toHaveLength(5);
    expect(ids('project:mob', { projects })).toEqual([]);
  });
  it('groups by project name', () => {
    const groups = evaluateQuery(tasks, parseQuery('group:project'), { ...ctx, projects }).groups!;
    expect(groups.map((g) => [g.label, g.count])).toEqual([['Mobile', 1], ['Website Redesign', 5]]);
  });
});
