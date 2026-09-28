import fs from 'node:fs';
import { expect, it } from 'vitest';
import { parse } from 'yaml';
import { anyCasts, budgetCheck } from '../scripts/lint.js';

const read = (file: string) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

it('counts casts to any, not annotations or the words in comments and strings (CI-32)', () => {
  expect(anyCasts('a.ts', [
    'const a = b as any;',
    'const c = (<any>d).e;',
    'const f = (g as any as Map<string, any>).size;',
    'const l = m as any[];',
    'function h(i: any): any { return i; }',
    '// x as any',
    "const j = 'k as any';",
  ].join('\n'))).toBe(4);
});

// Failing below budget too made two parallel pull requests that each removed
// one cast pass on their own and fail master together once both merged.
it('fails a budget only when a count is above it, and notes room to lower it', () => {
  expect(budgetCheck('as any casts in src', 10, 10)).toEqual({});
  expect(budgetCheck('as any casts in src', 11, 10).failure).toMatch(/11 as any casts in src; the budget is 10/);
  const below = budgetCheck('as any casts in src', 9, 10);
  expect(below.failure).toBeUndefined();
  expect(below.notice).toMatch(/9 as any casts in src, below the budget of 10.*npm run lint -- --update/);
});

it('lints in the required checks job', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; devDependencies: Record<string, string> };
  expect(pkg.scripts.lint).toBe('tsx scripts/lint.ts');
  expect(pkg.devDependencies.oxlint).toMatch(/^\d+\.\d+\.\d+$/);
  const ci = parse(read('.github/workflows/ci.yml')) as { jobs: { checks: { steps: Array<{ run?: string }> } } };
  expect(ci.jobs.checks.steps.map((step) => step.run)).toContain('npm run lint');
  const budget = JSON.parse(read('scripts/lint-budget.json')) as Record<string, number>;
  expect(Object.keys(budget).sort()).toEqual(['anyCasts', 'warnings']);
});
