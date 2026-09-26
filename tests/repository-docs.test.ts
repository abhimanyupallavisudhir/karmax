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
});
