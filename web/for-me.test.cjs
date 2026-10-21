// The "For me" list: what a `for:` query hides by default, the organization
// home's project filter, and the chip that says why a row is there.
// Run: node web/for-me.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const fn = (name) => { const start = src.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm')); assert.ok(start >= 0, name); return src.slice(start, src.indexOf('\n}', start) + 2); };
const constant = (name) => { const start = src.search(new RegExp(`^const ${name} =`, 'm')); assert.ok(start >= 0, name); return src.slice(start, src.indexOf('\n};', start) + 3).replace(/^const /, 'var '); };

test('a for: query keeps the sub-tasks and runs that wait on you; archived is never hidden implicitly', () => {
  const ctx = vm.createContext({});
  vm.runInContext(['queryMentionsFacet', 'queryNamesPerson', 'listShowsNested', 'effectiveQuery'].map(fn).join('\n'), ctx);
  assert.equal(ctx.effectiveQuery('for:me -is:archived'), 'for:me -is:archived');
  assert.equal(ctx.effectiveQuery('for:"Ana Lima" status:waiting'), 'for:"Ana Lima" status:waiting');
  assert.equal(ctx.effectiveQuery(''), '-is:run -is:subtask', 'the empty query includes archived tasks');
  assert.equal(ctx.effectiveQuery('-is:archived'), '-is:archived -is:run -is:subtask', 'the Active view');
  assert.equal(ctx.effectiveQuery('-for:me'), '-for:me -is:run -is:subtask', 'not waiting on you is an ordinary list');
  assert.equal(ctx.listShowsNested('for:me', 'subtask'), true);
  assert.equal(ctx.listShowsNested('status:active', 'subtask'), false);
});

test('the home project filter is one project: clause in the query', () => {
  const projects = [{ id: 'p1', name: 'Website Redesign', organizationId: 'o' }, { id: 'p2', name: 'App', organizationId: 'o' }];
  const ctx = vm.createContext({ S: { projects, organizationId: 'o' } });
  vm.runInContext(['slugify', 'projectSlug', 'addClause', 'queryProjectSlug', 'setProjectClause'].map(fn).join('\n'), ctx);
  assert.equal(ctx.setProjectClause('for:me', 'app'), 'for:me project:app');
  assert.equal(ctx.setProjectClause('for:me project:app status:waiting', 'website-redesign'), 'for:me status:waiting project:website-redesign');
  assert.equal(ctx.setProjectClause('project:"Website Redesign" for:me', ''), 'for:me');
  assert.equal(ctx.queryProjectSlug('for:me project:"website redesign"'), 'website-redesign', 'a name selects its project');
  assert.equal(ctx.queryProjectSlug('for:me project:P2'), 'app', 'so does an id');
});

test('a row says why it waits on you, briefly, with the reason in its tooltip', () => {
  const ctx = vm.createContext({ esc: (value) => String(value), S: { searchResult: { reasons: {
    a: ['review-requested'], b: ['escalated'], c: ['mentioned', 'escalated'], d: ['draft'], e: ['escalated'],
  } } } });
  vm.runInContext([constant('ATTENTION_REASONS'), constant('HOLD_REASONS'), constant('PULL_REQUEST_REASONS'), fn('rowAsk'), fn('attentionChip')].join('\n'), ctx);
  const chip = (id, lastView = {}) => ctx.attentionChip({ id, lastView });
  assert.match(chip('a'), />Review</);
  assert.match(chip('a'), /title="Waiting for your review"/);
  assert.match(chip('b'), />Input</);
  assert.match(chip('c'), />Input</, 'an ask outranks a mention');
  assert.equal(chip('d'), '', 'a draft row already says it is a draft');
  assert.match(chip('e', { waitingFor: { kind: 'human', reason: 'error' } }), />Failed</);
  assert.equal(chip('zz'), '', 'an "Active" row has no reason');
});

// pramana#102: a task working (or paused) whose pull request waits for review
// is listed for its reviewer — as its pull request's ask, not the task's Review.
test('a row whose pull request asks says so, and the task keeps its own status', () => {
  const ctx = vm.createContext({ esc: (value) => String(value), S: { searchResult: {
    reasons: { a: ['review-requested'], b: ['review-requested'] },
    pullRequestAsks: { a: [{ checkout: 'pramana', kind: 'review-requested' }] },
  } } });
  vm.runInContext([constant('ATTENTION_REASONS'), constant('HOLD_REASONS'), constant('PULL_REQUEST_REASONS'), fn('rowAsk'), fn('attentionChip')].join('\n'), ctx);
  const chip = (id) => ctx.attentionChip({ id, lastView: { stage: 'do', status: 'waiting', waitingFor: { kind: 'timer' } } });
  assert.match(chip('a'), />PR review</);
  assert.match(chip('a'), /title="The pull request for "pramana" waits for your review"/);
  assert.match(chip('b'), />Review</, 'the task itself at Review reads as before');
  assert.equal(ctx.rowAsk({ id: 'a' }).pullRequest, 'pramana');
  assert.equal(ctx.rowAsk({ id: 'b' }).pullRequest, undefined);
});

test('a row shows when it last changed: on For me, when it came to you', () => {
  const NOW = Date.UTC(2026, 9, 19, 23, 0);
  // rowWhen reads the clock: pin it to NOW, or the row ages past an hour as days pass.
  const Clock = class extends Date { static now() { return NOW; } };
  const ctx = vm.createContext({ Date: Clock, esc: (value) => String(value), S: { searchResult: { updated: { a: NOW - 80 * 60e3 } } } });
  vm.runInContext(['rowTime', 'fmtWhen', 'rowWhen'].map(fn).join('\n'), ctx);
  assert.equal(ctx.fmtWhen(NOW - 20e3, NOW), 'now');
  assert.equal(ctx.fmtWhen(NOW - 5 * 60e3, NOW), '5m');
  assert.equal(ctx.fmtWhen(NOW - 3 * 3600e3, NOW), '3h');
  assert.equal(ctx.fmtWhen(NOW - 4 * 86400e3, NOW), '4d');
  assert.match(ctx.fmtWhen(NOW - 20 * 86400e3, NOW), /Sep|29/, 'older rows show their date');
  assert.equal(ctx.rowTime({ id: 'a', statusChangedAt: NOW - 86400e3, createdAt: 1 }), NOW - 80 * 60e3, 'the server says when it came to you');
  assert.equal(ctx.rowTime({ id: 'b', statusChangedAt: NOW - 86400e3, createdAt: 1 }), NOW - 86400e3);
  assert.equal(ctx.rowTime({ id: 'c', createdAt: 7 }), 7, 'a draft: when it was created');
  assert.match(ctx.rowWhen({ id: 'a' }), /<time class="row-when" datetime="[^"]+" title="Updated [^"]+">\d+[mh]<\/time>/);
});

test('waits nobody takes part in do not move a task up the list', () => {
  const ctx = vm.createContext({});
  vm.runInContext(fn('listState'), ctx);
  const at = (status, kind, stage = 'do') => ctx.listState({ stage, status, ...(kind ? { waitingFor: { kind } } : {}) });
  for (const kind of ['agentSlot', 'job', 'timer', 'subtask', 'confirm', 'mergeSlot'])
    assert.equal(at('waiting', kind), at('active'), kind);
  assert.notEqual(at('waiting', 'human'), at('active'), 'needs a person');
  assert.notEqual(at('waiting', 'account'), at('active'), 'stalled on a login or quota');
  assert.notEqual(at('done'), at('active'));
  assert.notEqual(at('waiting', 'human', 'review'), at('waiting', 'human'), 'a new stage');
});
