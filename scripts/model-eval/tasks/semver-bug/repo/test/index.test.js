import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, compare, satisfies, maxSatisfying } from '../src/index.js';

test('parses versions', () => {
  assert.deepEqual(parse('1.2.3'), { major: 1, minor: 2, patch: 3 });
  assert.deepEqual(parse('v10.0.1'), { major: 10, minor: 0, patch: 1 });
  assert.equal(parse('1.2'), null);
});

test('compares versions', () => {
  assert.equal(compare('1.2.3', '1.2.10'), -1);
  assert.equal(compare('2.0.0', '1.9.9'), 1);
  assert.equal(compare('1.0.0', '1.0.0'), 0);
});

test('caret ranges', () => {
  assert.ok(satisfies('1.4.2', '^1.2.3'));
  assert.ok(!satisfies('2.0.0', '^1.2.3'));
  assert.ok(!satisfies('1.2.2', '^1.2.3'));
});

test('tilde, x and comparison ranges', () => {
  assert.ok(satisfies('1.2.9', '~1.2.3'));
  assert.ok(!satisfies('1.3.0', '~1.2.3'));
  assert.ok(satisfies('1.9.0', '1.x'));
  assert.ok(satisfies('3.0.0', '>=2.0.0 <4'));
  assert.ok(satisfies('1.5.0', '1.2.3 - 2.3'));
  assert.ok(satisfies('0.1.0', '<1.0.0 || >=3'));
});

test('maxSatisfying', () => {
  assert.equal(maxSatisfying(['1.2.3', '1.3.0', '2.0.0'], '^1.2.0'), '1.3.0');
  assert.equal(maxSatisfying(['1.2.3'], '^2'), null);
});
