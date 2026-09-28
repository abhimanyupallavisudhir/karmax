import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const read = (file: string) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

describe('repository guidance', () => {
  it('keeps one authoritative agent guide', () => {
    expect(read('AGENTS.md').trim()).toBe('See [CLAUDE.md](CLAUDE.md) for the repository guidance.');
    expect(read('CLAUDE.md')).toContain('Coordinators have no version pin');
  });

  it('documents that paid suites require an explicit opt-in', () => {
    expect(read('TESTING.md')).toContain('KARMAX_RUN_LIVE=1');
    expect(read('CLAUDE.md')).toContain('KARMAX_RUN_LIVE=1');
  });

  it('tells reporters and contributors where to go (CI-36)', () => {
    expect(read('SECURITY.md')).toMatch(/Report a vulnerability/);
    expect(read('CONTRIBUTING.md')).toContain('CLAUDE.md');
    // Deployment code runs on production with its secrets: an owner reviews it.
    const owners = read('.github/CODEOWNERS').split('\n').filter(line => line.trim() && !line.startsWith('#'))
      .map(line => line.trim().split(/\s+/));
    for (const pattern of ['/.github/workflows/', '/.github/actions/', '/deploy/', '/.github/CODEOWNERS'])
      expect(owners.find(([path]) => path === pattern)?.slice(1), pattern).toContain('@abhimanyupallavisudhir');
  });

  it('requires the first Node release with the SQLite APIs the app uses', () => {
    const pkg = JSON.parse(read('package.json')) as { engines: { node: string } };
    expect(pkg.engines.node).toBe('>=22.16.0');
    expect(read('.nvmrc').trim()).toBe('22.16.0');
  });

  it('tracks only benchmark evidence linked by docs and design sources used by tests', () => {
    const tracked = execFileSync('git', ['ls-files', 'design', 'benchmarks/results', 'deploy/e2b.Dockerfile'], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8',
    }).trim().split('\n');
    expect(tracked.some(file => file === 'deploy/e2b.Dockerfile')).toBe(false);
    expect(tracked.some(file => file.startsWith('design/') && file.endsWith('.png'))).toBe(false);
    expect(tracked.some(file => file === 'benchmarks/results/native-async-capacity-2026-09-20.md')).toBe(false);
    expect(tracked).toContain('design/gold-logo-options/gold-check.svg');
    expect(tracked).toContain('benchmarks/results/latency-live-2026-09-18.json.gz');
    expect(execFileSync('git', ['check-ignore', 'design/gold-logo-options/gold-check.png'], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8',
    }).trim()).toBe('design/gold-logo-options/gold-check.png');
  });

  it('cites design plans as wiki pages, never as missing repository files', () => {
    let found = '';
    try {
      found = execFileSync('git', ['grep', '-nE', 'PLAN[-_A-Za-z]*\\.md', '--', 'src', 'web', 'tests', 'CLAUDE.md'], {
        cwd: new URL('..', import.meta.url), encoding: 'utf8',
      });
    } catch (error) {
      if ((error as { status?: number }).status !== 1) throw error; // 1 = no match
    }
    const cites = found.split('\n').filter(line => line && !line.includes('PLAN-*.md') && !line.startsWith('tests/repository-docs.test.ts'));
    expect(cites).toEqual([]);
  });

  it('links every tracked benchmark result from a repository doc', () => {
    const ls = (...args: string[]) => execFileSync('git', ['ls-files', ...args], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8',
    }).trim().split('\n').filter(Boolean);
    const docs = ls('*.md').map(read).join('\n');
    const orphans = ls('benchmarks/results').filter(file => !file.endsWith('.md'))
      .filter(file => !docs.includes(file.split('/').pop()!));
    expect(orphans).toEqual([]);
  });
});
