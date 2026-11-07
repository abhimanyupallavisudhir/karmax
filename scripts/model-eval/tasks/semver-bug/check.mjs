import assert from 'node:assert/strict';
const work = process.argv[2];
const { satisfies, maxSatisfying } = await import(`${work}/src/index.js`);
const cases = [
  ['0.2.3', '^0.2.3', true], ['0.2.9', '^0.2.3', true], ['0.3.0', '^0.2.3', false], ['0.9.1', '^0.2.3', false], ['0.2.2', '^0.2.3', false],
  ['0.0.3', '^0.0.3', true], ['0.0.4', '^0.0.3', false], ['0.1.0', '^0.0.3', false],
  ['0.0.9', '^0.0', true], ['0.1.0', '^0.0', false],
  ['0.9.0', '^0', true], ['1.0.0', '^0', false],
  ['0.2.0', '^0.2', true], ['0.2.7', '^0.2', true], ['0.3.0', '^0.2', false],
  ['0.0.5', '^0.0.x', true], ['0.1.0', '^0.0.x', false],
  ['1.9.9', '^1.2.3', true], ['2.0.0', '^1.2.3', false], ['1.2.2', '^1.2.3', false],
  ['1.5.0', '^1.2', true], ['2.0.0', '^1', false],
  ['1.2.9', '~1.2.3', true], ['1.3.0', '~1.2.3', false], ['0.2.5', '~0.2', true],
  ['3.0.0', '>=2.0.0 <4', true], ['1.5.0', '1.2.3 - 2.3', true], ['2.3.9', '1.2.3 - 2.3', true], ['2.4.0', '1.2.3 - 2.3', false],
  ['0.2.5', '^0.2.3 || ^1.0.0', true], ['0.5.0', '^0.2.3 || ^1.0.0', false], ['0.3.1', '^ 0.3.0', true], ['0.4.0', '^ 0.3.0', false],
];
const bad = cases.filter(([v, r, want]) => { try { return satisfies(v, r) !== want; } catch { return true; } });
let ok = bad.length === 0;
try { assert.equal(maxSatisfying(['0.2.3', '0.2.9', '0.3.0', '0.9.1'], '^0.2.3'), '0.2.9'); } catch { ok = false; bad.push(['maxSatisfying']); }
console.log(ok ? 'PASS' : 'FAIL', JSON.stringify(bad)); process.exit(ok ? 0 : 1);
