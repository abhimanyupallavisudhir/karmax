import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ci = parse(fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8'));

describe('CI workflow', () => {
  // Branch protection and Karmax's merge gate both key on this check name, so
  // it has to stand for everything a landing needs, not just one job of it.
  it('reports the required check after static checks, every test shard, and deploy artifacts', () => {
    const required = ci.jobs.required;
    expect(required.name).toBe('typecheck + tests');
    expect([...required.needs].sort()).toEqual(['checks', 'deploy-artifacts', 'test']);
    // It must still run, and fail, when a needed job failed or was cancelled.
    expect(required.if).toBe('always()');
  });

  it('passes the required check only when every needed job succeeded', () => {
    const [step] = ci.jobs.required.steps;
    expect(step.env.RESULTS).toBe("${{ join(needs.*.result, ' ') }}");
    // Without GitHub's implicit `-e`, so the script's own exits are what count.
    const verdict = (results: string) =>
      spawnSync('bash', ['-c', step.run], { env: { ...process.env, RESULTS: results } }).status;
    expect(verdict('success success success')).toBe(0);
    for (const result of ['failure', 'cancelled', 'skipped']) {
      for (const index of [0, 1, 2]) {
        const statuses = ['success', 'success', 'success'];
        statuses[index] = result;
        expect(verdict(statuses.join(' '))).not.toBe(0);
      }
    }
    expect(verdict('')).not.toBe(0);
  });

  // The suite runs one file at a time per machine (vitest.config.ts); CI
  // divides the files between machines instead. Every shard must run, and one
  // shard's failure must not cancel the others' results.
  it('runs every shard of the suite to completion', () => {
    const test = ci.jobs.test;
    const shards: number[] = test.strategy.matrix.shard;
    expect(shards.length).toBeGreaterThan(1);
    expect(shards).toEqual(shards.map((_, index) => index + 1));
    expect(test.strategy['fail-fast']).toBe(false);
    expect(test.steps.map((step: any) => step.run))
      .toContain('npm test -- --shard=${{ matrix.shard }}/${{ strategy.job-total }}');
  });

  // tests/web-regressions.test.ts executes every web/*.test.cjs as part of the
  // suite above, so those regressions are already inside the required check.
  it('covers the standalone UI and browser regressions through the sharded suite', () => {
    expect(fs.readdirSync(path.join(repoRoot, 'web')).some((name) => name.endsWith('.test.cjs'))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, 'tests', 'web-regressions.test.ts'))).toBe(true);
  });
});
