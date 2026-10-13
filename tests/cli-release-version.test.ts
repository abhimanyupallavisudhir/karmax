import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { nextCliVersion, writeCliVersion } from '../scripts/cli-release-version.mjs';

// Pull requests no longer pick CLI versions: two in flight always conflicted
// on cli/package.json's version line (GL-5). The release computes it instead.
describe('the next @tavya/cli release version', () => {
  it('releases the next patch after the newest tag when what the CLI ships changed', () => {
    expect(nextCliVersion({ floor: '1.4.0', released: ['1.2.2', '1.4.0', '1.3.0'], shippedChanged: true }))
      .toEqual({ version: '1.4.1', release: true });
    expect(nextCliVersion({ floor: '1.4.0', released: ['1.4.0', '1.4.9', '1.4.10'], shippedChanged: true }))
      .toEqual({ version: '1.4.11', release: true });
  });

  it('releases nothing when the CLI did not change', () => {
    expect(nextCliVersion({ floor: '1.4.0', released: ['1.4.0', '1.4.3'], shippedChanged: false }))
      .toEqual({ version: '1.4.3', release: false });
  });

  it('releases a raised floor: a minor or major bump is the one version a pull request still sets', () => {
    expect(nextCliVersion({ floor: '1.5.0', released: ['1.4.3'], shippedChanged: true }))
      .toEqual({ version: '1.5.0', release: true });
    expect(nextCliVersion({ floor: '2.0.0', released: ['1.9.9'], shippedChanged: false }))
      .toEqual({ version: '2.0.0', release: true });
  });

  it('releases the floor when nothing was released yet, and ignores tags that are not versions', () => {
    expect(nextCliVersion({ floor: '1.0.0', released: [], shippedChanged: true })).toEqual({ version: '1.0.0', release: true });
    expect(nextCliVersion({ floor: '1.0.0', released: ['1.0.0-rc.1', 'latest'], shippedChanged: true }))
      .toEqual({ version: '1.0.0', release: true });
  });

  it('writes the version into the package and its lock for the release build', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-version-'));
    try {
      fs.mkdirSync(path.join(root, 'cli'));
      fs.writeFileSync(path.join(root, 'cli/package.json'), JSON.stringify({ name: '@tavya/cli', version: '1.4.0' }));
      fs.writeFileSync(path.join(root, 'cli/package-lock.json'), JSON.stringify({
        name: '@tavya/cli', version: '1.4.0', packages: { '': { name: '@tavya/cli', version: '1.4.0' }, 'node_modules/esbuild': { version: '0.28.1' } },
      }));
      writeCliVersion(root, '1.4.7');
      expect(JSON.parse(fs.readFileSync(path.join(root, 'cli/package.json'), 'utf8')).version).toBe('1.4.7');
      const lock = JSON.parse(fs.readFileSync(path.join(root, 'cli/package-lock.json'), 'utf8'));
      expect([lock.version, lock.packages[''].version, lock.packages['node_modules/esbuild'].version]).toEqual(['1.4.7', '1.4.7', '0.28.1']);
      expect(() => writeCliVersion(root, '1.4')).toThrow(/not a release version/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports this checkout without changing it', () => {
    const before = fs.readFileSync('cli/package.json', 'utf8');
    const out = JSON.parse(execFileSync(process.execPath, ['scripts/cli-release-version.mjs'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim().split('\n').at(-1)!);
    expect(out).toMatchObject({ version: expect.stringMatching(/^\d+\.\d+\.\d+$/), release: expect.any(Boolean) });
    expect(out.tag).toBe(`cli-v${out.version}`);
    expect(fs.readFileSync('cli/package.json', 'utf8')).toBe(before);
  }, 60_000);
});
