import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ci = parse(fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8'));

describe('CI workflow', () => {
  // Branch protection and Karmax's merge gate both key on this check name, so
  // it has to stand for everything a landing needs, not just one job of it.
  it('reports the required check after static checks, every test shard, deploy artifacts and the CLI version bump', () => {
    const required = ci.jobs.required;
    expect(required.name).toBe('typecheck + tests');
    expect([...required.needs].sort()).toEqual(['checks', 'cli-version', 'deploy-artifacts', 'test']);
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

// CI #1709 failed only on Docker Hub's anonymous pull limit (429). Every job
// that pulls from Docker Hub logs in first, except on fork pull requests, which
// get no secrets and must still run.
describe('Docker Hub login', () => {
  type Step = { name?: string; if?: string; uses?: string; run?: string; with?: Record<string, string> };
  const login = (steps: Step[]) => steps.findIndex((step) => step.uses?.startsWith('docker/login-action@'));

  it.each([
    ['test', 'npm test -- --shard='],
    ['deploy-artifacts', './deploy/karmax up '],
  ])('%s logs in, pinned and skipped without the secret, before it pulls', (name, pull) => {
    const job = ci.jobs[name];
    const steps: Step[] = job.steps;
    const index = login(steps);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThan(steps.findIndex((step) => step.run?.startsWith(pull)));
    const step = steps[index]!;
    expect(step.uses).toMatch(/^docker\/login-action@[0-9a-f]{40}$/);
    expect(job.env.DOCKERHUB_USERNAME).toBe('${{ secrets.DOCKERHUB_USERNAME }}');
    expect(step.if).toContain("env.DOCKERHUB_USERNAME != ''");
    expect(step.with).toEqual({ username: '${{ env.DOCKERHUB_USERNAME }}', password: '${{ secrets.DOCKERHUB_TOKEN }}' });
  });

  // Services are pulled before any step runs; the runner skips the login when
  // the credentials are empty.
  it('pulls the test shards\' services with the same credentials', () => {
    for (const service of Object.values<any>(ci.jobs.test.services))
      expect(service.credentials).toEqual({
        username: '${{ secrets.DOCKERHUB_USERNAME }}', password: '${{ secrets.DOCKERHUB_TOKEN }}',
      });
  });
});

describe('deploy artifacts', () => {
  type Step = { id?: string; name?: string; if?: string; run?: string; env?: Record<string, string> };
  const steps: Step[] = ci.jobs['deploy-artifacts'].steps;
  const runs = steps.map((step) => step.run ?? '').join('\n');
  const scope = steps.find((step) => step.id === 'scope')!;

  // CI-13: the image used to be built and never started, so nothing proved a
  // hosted cell boots on PostgreSQL and Temporal the way operators install it.
  it('installs the turnkey stack with the operator command and routes the edge to it', () => {
    expect(runs).toContain('./deploy/karmax up karmax.localhost preview.karmax.localhost');
    expect(runs).toContain("[ \"$redirect\" = '308 https://karmax.localhost/api/health/ready' ]");
    // Caddy runs on the host network (CI-8): it reaches the app where its
    // reverse_proxy does, on the host loopback port, not by Compose DNS.
    expect(runs).toContain('docker compose exec -T caddy wget -qO- http://127.0.0.1:4505/api/health/ready');
    expect(runs).not.toContain('app:4505');
  });

  it('proves the booted app uses its own database role and never sees the superuser password (CI-7)', () => {
    expect(runs).toContain("[ \"$sessions\" = 'karmax superuser=false' ]");
    expect(runs).toContain("grep -F 'The app connects to PostgreSQL as karmax, not a superuser.'");
    expect(runs).toContain('/run/karmax-database/*');
    expect(runs).toContain("tableowner <> 'karmax'");
    expect(runs).toContain('grep -qF "$password"');
  });

  it('checks every artifact only when the change can affect one', () => {
    for (const step of steps.slice(steps.indexOf(scope) + 1))
      expect(step.if, step.name).toContain("steps.scope.outputs.artifacts == 'true'");
  });

  describe('decides the scope from the pull request\'s changed paths', () => {
    /** Run the scope step on a merge commit that changes `files`. */
    function decide(event: string, files: string[]): string {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-ci-scope-'));
      try {
        const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=ci', '-c', 'user.email=ci@example.test',
          '-c', 'commit.gpgsign=false', ...args], { cwd: repo });
        git('init', '-q');
        git('commit', '-q', '--allow-empty', '-m', 'base');
        for (const file of files) {
          fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
          fs.writeFileSync(path.join(repo, file), 'changed\n');
        }
        git('add', '-A');
        git('commit', '-q', '--allow-empty', '-m', 'change');
        const output = path.join(repo, 'output');
        const result = spawnSync('bash', ['-e', '-c', scope.run!], {
          cwd: repo, encoding: 'utf8', env: { ...process.env, EVENT: event, GITHUB_OUTPUT: output },
        });
        expect(result.status, result.stderr).toBe(0);
        return fs.readFileSync(output, 'utf8');
      } finally { fs.rmSync(repo, { recursive: true, force: true }); }
    }

    it.each([
      [['src/main.ts']],
      [['web/app.js', 'tests/gateway.test.ts']],
      [['deploy/README.md']],
      [['package-lock.json']],
      [['.dockerignore']],
      [['.github/workflows/ci.yml']],
      [['environments/browser/Dockerfile']],
      [['a new top-level file']],
    ])('builds when %j changes', (files) => {
      expect(decide('pull_request', files)).toBe('artifacts=true\n');
    });

    it.each([
      [['tests/gateway.test.ts', 'tests/helpers/harness.ts']],
      [['docs/response-timing.md', 'README.md', 'TESTING.md']],
      [['web/lists.test.cjs', 'web/sub/deep.test.cjs']],
      [['design/logo.svg', 'benchmarks/results/README.md', 'scripts/lint.ts']],
      [['.github/workflows/live.yml', '.github/CODEOWNERS']],
    ])('skips when only %j changes', (files) => {
      expect(decide('pull_request', files)).toBe('artifacts=false\n');
    });

    it.each(['push', 'merge_group', 'workflow_dispatch'])('always builds on %s', (event) => {
      expect(decide(event, ['tests/gateway.test.ts'])).toBe('artifacts=true\n');
    });
  });
});
