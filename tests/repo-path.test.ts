import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { expandPath } from '../src/util/expand.js';
import { WorktreeProvider } from '../src/world/worktree.js';
import { git, gitOrThrow, ensureIdentity } from '../src/world/git.js';

describe('expandPath', () => {
  it('expands ~ and $HOME to the home directory', () => {
    expect(expandPath('~')).toBe(os.homedir());
    expect(expandPath('~/code/app')).toBe(path.join(os.homedir(), 'code/app'));
    expect(expandPath('$HOME/x')).toBe(path.join(os.homedir(), 'x'));
    expect(expandPath('${HOME}/y')).toBe(path.join(os.homedir(), 'y'));
    expect(expandPath('/abs/path')).toBe('/abs/path');
  });
});

describe('WorktreeProvider repo resolution (regression: ~ path silently scratched)', () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-rp-'));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('resolves a ~-prefixed repo path to the real repo (not a scratch repo)', async () => {
    // a real git repo under the home directory
    const rel = `.karmax-test-repo-${Date.now()}`;
    const repoAbs = path.join(os.homedir(), rel);
    fs.mkdirSync(repoAbs, { recursive: true });
    try {
      await gitOrThrow(repoAbs, ['init', '-q', '-b', 'main']);
      await ensureIdentity(repoAbs);
      fs.writeFileSync(path.join(repoAbs, 'README.md'), '# r\n');
      await git(repoAbs, ['add', '-A']);
      await git(repoAbs, ['commit', '-q', '-m', 'init']);

      const provider = new WorktreeProvider(home);
      const world = await provider.create({ taskId: 'rp1', repo: `~/${rel}`, base: 'main', target: 'main' });
      // the world points at the REAL repo, not a scratch repo
      expect(world.handle.repo).toBe(repoAbs);
      expect(world.handle.repo).not.toMatch(/scratch-/);
      await world.destroy();
    } finally {
      fs.rmSync(repoAbs, { recursive: true, force: true });
    }
  });

  it('throws (does not silently scratch) when a configured repo path is invalid', async () => {
    const provider = new WorktreeProvider(home);
    await expect(
      provider.create({ taskId: 'rp2', repo: '/no/such/repo/here', base: 'main' }),
    ).rejects.toThrow(/not a git repository/i);
  });

  it('still creates a scratch repo only when NO repo is configured', async () => {
    const provider = new WorktreeProvider(home);
    const world = await provider.create({ taskId: 'rp3', base: 'main' });
    expect(world.handle.repo).toMatch(/scratch-/);
    await world.destroy();
  });
});
