import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'live.yml'), 'utf8');
const live = parse(source);
type Step = { id?: string; run?: string; uses?: string; env?: Record<string, string> };
type Job = { needs?: string; if?: string; environment?: string; steps: Step[] };
const jobs = live.jobs as Record<string, Job>;
const suites = Object.entries(jobs).filter(([name]) => name !== 'plan');
const plan = jobs.plan!.steps.find((step) => step.id === 'plan')!;
// A dispatch runs the chosen ref's workflow and test code with the secrets.
// The live environment restricted to master is the control; this guard means
// a branch must also rewrite this workflow, not just its tests.
const MASTER = "github.ref == 'refs/heads/master'";

// CI-4: the paid live suites ran only when someone remembered KARMAX_RUN_LIVE=1,
// so provider drift was found in production.
describe('live-test workflow', () => {
  it('runs on demand, or on a schedule only once the repository opts in', () => {
    expect(Object.keys(live.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
    expect(live.on.schedule).toHaveLength(1);
    expect(live.on.workflow_dispatch.inputs.suite.options).toEqual(['all', ...suites.map(([name]) => name)]);
    expect(jobs.plan!.if).toBe(`${MASTER} && (github.event_name == 'workflow_dispatch' || vars.KARMAX_LIVE_SCHEDULE == 'true')`);
    expect(live.permissions).toEqual({ contents: 'read' });
  });

  it('runs every suite behind the live gate', () => {
    const gated = fs.readdirSync(path.join(repoRoot, 'tests'))
      .filter((file) => file.endsWith('.test.ts') && !['live-gate.test.ts', 'live-workflow.test.ts'].includes(file))
      .filter((file) => fs.readFileSync(path.join(repoRoot, 'tests', file), 'utf8').includes("from './helpers/live-gate.js'"));
    const run = suites.flatMap(([, job]) => job.steps.map((step) => step.run ?? '')).join('\n');
    expect(gated.length).toBeGreaterThan(5);
    for (const file of gated) expect(run, file).toContain(`tests/${file}`);
  });

  it('starts each suite only when the plan chose it, with the live gate open', () => {
    for (const [name, job] of suites) {
      expect(job.needs, name).toBe('plan');
      expect(job.if, name).toBe(`${MASTER} && needs.plan.outputs.${name} == 'true'`);
      expect(live.jobs.plan.outputs[name], name).toBe(`\${{ steps.plan.outputs.${name} }}`);
      expect(job.steps.find((step) => step.run?.includes('npx vitest run'))?.env?.KARMAX_RUN_LIVE, name).toBe('1');
    }
  });

  // Anyone who can push a branch can run a workflow; the environment lets the
  // owner restrict these secrets to master and require an approval to spend.
  it('keeps the secrets in the live environment and gives each suite only its own', () => {
    for (const [name, job] of Object.entries(jobs))
      if (JSON.stringify(job).includes('secrets.')) expect(job.if, name).toMatch(new RegExp(`^${MASTER.replace(/[.()]/g, '\\$&')} && `));
    for (const [name, job] of [['plan', jobs.plan!] as const, ...suites]) expect(job.environment, name).toBe('live');
    const own: Record<string, string[]> = {};
    for (const [name, job] of suites) own[name] = [...JSON.stringify(job).matchAll(/secrets\.(\w+)/g)].map((m) => m[1]!).sort();
    for (const [name, secrets] of Object.entries(own)) {
      expect(secrets.length, name).toBeGreaterThan(0);
      for (const [other, theirs] of Object.entries(own))
        if (other !== name && !(name === 'models' && other === 'agent') && !(name === 'agent' && other === 'models'))
          expect(secrets.filter((secret) => theirs.includes(secret)), `${name} and ${other}`).toEqual([]);
    }
    expect(Object.keys(plan.env!).filter((key) => key.startsWith('LIVE_')).sort())
      .toEqual([...new Set(Object.values(own).flat())].sort());
  });

  describe('plan', () => {
    function decide(env: Record<string, string>): Record<string, string> {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-live-plan-'));
      try {
        const output = path.join(dir, 'output');
        const result = spawnSync('bash', ['-e', '-c', plan.run!], {
          encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_OUTPUT: output, SELECTED: 'all', ...env },
        });
        expect(result.status, result.stderr).toBe(0);
        return Object.fromEntries(fs.readFileSync(output, 'utf8').trim().split('\n').map((line) => line.split('=') as [string, string]));
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
    const none = Object.fromEntries(suites.map(([name]) => [name, 'false']));

    it('skips every suite when no secret is configured', () => {
      expect(decide({})).toEqual(none);
    });

    it('runs each suite whose secret is configured', () => {
      expect(decide({ LIVE_E2B_API_KEY: 'e2b' })).toEqual({ ...none, e2b: 'true' });
      expect(decide({ LIVE_OPENAI_API_KEY: 'sk' })).toEqual({ ...none, models: 'true', agent: 'true' });
      expect(decide({ LIVE_ANTHROPIC_API_KEY: 'sk-ant' })).toEqual({ ...none, models: 'true' });
      expect(decide({ LIVE_GITHUB_FORK_TOKEN: 'ghp' })).toEqual({ ...none, github: 'true' });
      const all = Object.fromEntries(Object.keys(plan.env!).filter((key) => key.startsWith('LIVE_')).map((key) => [key, 'set']));
      expect(decide(all)).toEqual(Object.fromEntries(suites.map(([name]) => [name, 'true'])));
    });

    it('runs only the suite a dispatch selected', () => {
      const all = Object.fromEntries(Object.keys(plan.env!).filter((key) => key.startsWith('LIVE_')).map((key) => [key, 'set']));
      expect(decide({ ...all, SELECTED: 'github' })).toEqual({ ...none, github: 'true' });
      expect(decide({ SELECTED: 'github' })).toEqual(none);
    });
  });
});
