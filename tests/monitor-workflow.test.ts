import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * The production smoke test outside the deploy (wiki ops/release-and-deploy,
 * "Smoke test"): `monitor.yml` runs it against tavya.io from GitHub, and
 * `deploy.yml` hands the deploy gate its token.
 */
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string) => fs.readFileSync(path.join(repoRoot, file), 'utf8');
const monitorSource = read('.github/workflows/monitor.yml');
const monitor = parse(monitorSource);
const deploy = parse(read('.github/workflows/deploy.yml'));
const job = monitor.jobs.smoke;
const steps: Array<{ name?: string; uses?: string; run?: string; env?: Record<string, string>; if?: string }> = job.steps;
const script = steps.map((step) => step.run ?? '').join('\n');

describe('the production monitor', () => {
  it('runs every ten minutes, after every deploy and on demand', () => {
    expect(monitor.on.schedule).toEqual([{ cron: '*/10 * * * *' }, { cron: '5 * * * *' }]);
    expect(monitor.on.workflow_run).toEqual({ workflows: ['Deploy'], types: ['completed'] });
    expect(monitor.on).toHaveProperty('workflow_dispatch');
  });

  it('can only open issues, and only the canonical repository (or one that names its own instance) probes', () => {
    expect(monitor.permissions).toEqual({ contents: 'read', issues: 'write' });
    expect(job.if).toContain("github.repository == 'abhimanyupallavisudhir/karmax'");
    expect(job.if).toContain("vars.TAVYA_MONITOR_URL != ''");
  });

  it('pins every action to a commit', () => {
    for (const step of steps.filter((entry) => entry.uses))
      expect(step.uses).toMatch(/@[0-9a-f]{40}\b/);
  });

  // The monitor must not need the 1.5 GB node_modules: the smoke test is
  // node: modules only, run by the lockfile's tsx.
  it('runs the smoke test without installing the project, with the lockfile\'s tsx', () => {
    expect(script).not.toMatch(/npm (ci|install)/);
    expect(script).toContain("require('./package-lock.json').packages['node_modules/tsx'].version");
    expect(script).toContain('src/scripts/smoke.ts');
    for (const file of ['src/ops/smoke.ts', 'src/scripts/smoke.ts']) {
      const imports = [...read(file).matchAll(/^import .* from '([^']+)';$/gm)].map((match) => match[1]!);
      expect(imports.filter((source) => !source.startsWith('node:') && source !== '../ops/smoke.js')).toEqual([]);
    }
  });

  it('runs the signed-in journey hourly and after deploys, and reminds before the token expires', () => {
    expect(script).toContain('TAVYA_SMOKE_TOKEN');
    expect(script).toContain('--expiring-within-days 14');
    expect(monitorSource).toContain('secrets.TAVYA_SMOKE_TOKEN');
    // Visitor checks only on the ten-minute schedule; the hourly one (which
    // GitHub names, however late it starts) runs the journey.
    expect(steps.find((step) => step.env?.SCHEDULE)?.env?.SCHEDULE).toBe('${{ github.event.schedule }}');
    expect(script).toContain('"$SCHEDULE" = \'5 * * * *\'');
  });

  it('confirms a failure once before it alerts', () => {
    expect(script).toMatch(/sleep 60/);
  });

  it('opens one issue while production fails, and closes it when it recovers', () => {
    expect(script).toContain('gh issue create');
    expect(script).toContain('gh issue close');
    expect(script).toContain('production-smoke');
    // An inconclusive run (no computer free) neither opens nor closes it.
    expect(script).toMatch(/3\)/);
  });
});

describe('the deploy hands its gate the smoke token', () => {
  const run = JSON.stringify(deploy.jobs.deploy.steps);
  it('writes the secret to the host privately, through stdin, before the update starts', () => {
    expect(run).toContain('secrets.TAVYA_SMOKE_TOKEN');
    expect(run).toContain('deploy/.secrets/smoke_token');
    expect(run).toContain('umask 077');
    expect(run.indexOf('smoke_token')).toBeLessThan(run.indexOf('.karmax-runner start'));
    // Never on a command line: only ever piped into ssh.
    const lines = (deploy.jobs.deploy.steps as Array<{ run?: string }>).flatMap((step) => (step.run ?? '').split('\n'));
    const uses = lines.filter((line) => line.includes('$SMOKE_TOKEN') && /\bssh\b/.test(line));
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) expect(line).toMatch(/"\$SMOKE_TOKEN" \| ssh /);
  });
});
