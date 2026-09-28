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

  it('names host capacity where the console shows it (WK-2j)', () => {
    expect(read('web/app.js')).toContain('id="installation-capacity"><div>Host capacity');
    expect(read('CLAUDE.md')).toContain('**Installation → Host capacity → Concurrent agent turns**');
    expect(read('CLAUDE.md')).not.toContain('Global settings');
    expect(read('src/activities/core.ts')).toContain('Reduce Concurrent agent turns under Installation → Host capacity');
  });

  it('lists the coordinators that run, not the unused budget coordinator (WK-2k)', () => {
    const lines = [
      read('CLAUDE.md').split('\n').find(line => line.startsWith('- `src/coordinators/`')),
      read('README.md').split('\n').find(line => line.startsWith('- `src/coordinators/`')),
      read('README.md').split('\n').find(line => line.startsWith('| Coordinators')),
    ];
    for (const line of lines) {
      expect(line).toMatch(/agent-queue/);
      expect(line).toMatch(/resource-publish/);
      expect(line).not.toMatch(/\bbudget\b(?!\.ts)/);
    }
  });

  it('does not document the removed safe-mode control or tick unwired overlays (CI-21, WK-2m)', () => {
    let found = '';
    try {
      found = execFileSync('git', ['grep', '-niE', 'safe[ -]?mode', '--', '*.md', 'src', ':!src/store/overlays.ts'], {
        cwd: new URL('..', import.meta.url), encoding: 'utf8',
      });
    } catch (error) {
      if ((error as { status?: number }).status !== 1) throw error; // 1 = no match
    }
    expect(found.split('\n').filter(Boolean)).toEqual([]);
    expect(read('src/store/overlays.ts')).toMatch(/not wired/i);
    const overlays = read('README.md').split('\n').find(line => line.includes('overlay resolution'));
    expect(overlays).toBeDefined();
    expect(overlays).not.toContain('✅');
    expect(read('README.md')).toMatch(/\*\*Names\.\*\* \*tavya\*[^\n]*\*karmax\*[^\n]*\*krmax\*/);
  });

  it('describes the file vault as the backend in use (WK-2p)', () => {
    const vault = read('src/autonomy/vault.ts');
    expect(vault).not.toMatch(/in production it would be/);
    expect(vault).toMatch(/KARMAX_VAULT_KEY/);
  });

  it('says which key seals new sandbox references (WD-30a)', () => {
    for (const file of ['src/world/e2b.ts', 'src/world/daytona.ts', 'src/runtime/execution-services.ts', 'HOSTING.md']) {
      const text = read(file);
      expect(text, file).not.toContain('Hosted deployments must set KARMAX_WORLD_REF_KEY');
      expect(text, file).not.toContain('Restore the original KARMAX_WORLD_REF_KEY;');
      expect(text, file).toMatch(/world-reference:key:v2|WorldReferenceKeys/);
    }
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
