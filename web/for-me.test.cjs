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

test('a for: query keeps the sub-tasks and runs that wait on you; archived stays hidden', () => {
  const ctx = vm.createContext({});
  vm.runInContext(['queryMentionsFacet', 'queryNamesPerson', 'listShowsNested', 'effectiveQuery'].map(fn).join('\n'), ctx);
  assert.equal(ctx.effectiveQuery('for:me'), 'for:me -is:archived');
  assert.equal(ctx.effectiveQuery('for:"Ana Lima" status:waiting'), 'for:"Ana Lima" status:waiting -is:archived');
  assert.equal(ctx.effectiveQuery(''), '-is:archived -is:run -is:subtask');
  assert.equal(ctx.effectiveQuery('-for:me'), '-for:me -is:archived -is:run -is:subtask', 'not waiting on you is an ordinary list');
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
  vm.runInContext([constant('ATTENTION_REASONS'), constant('HOLD_REASONS'), fn('attentionChip')].join('\n'), ctx);
  const chip = (id, lastView = {}) => ctx.attentionChip({ id, lastView });
  assert.match(chip('a'), />Review</);
  assert.match(chip('a'), /title="Waiting for your review"/);
  assert.match(chip('b'), />Input</);
  assert.match(chip('c'), />Input</, 'an ask outranks a mention');
  assert.equal(chip('d'), '', 'a draft row already says it is a draft');
  assert.match(chip('e', { waitingFor: { kind: 'human', reason: 'error' } }), />Failed</);
  assert.equal(chip('zz'), '', 'an "All" row has no reason');
});
