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

  it('clones a configured Git URL into managed storage before creating the worktree', async () => {
    const seed = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-rp-seed-'));
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-rp-origin-'));
    try {
      await gitOrThrow(seed, ['init', '-q', '-b', 'main']);
      await ensureIdentity(seed);
      fs.writeFileSync(path.join(seed, 'README.md'), '# remote\n');
      await git(seed, ['add', '-A']);
      await git(seed, ['commit', '-q', '-m', 'init']);
      await gitOrThrow(bare, ['init', '-q', '--bare', '-b', 'main']);
      await git(seed, ['remote', 'add', 'origin', bare]);
      await gitOrThrow(seed, ['push', '-q', 'origin', 'main']);

      const source = `file://${bare}`;
      const provider = new WorktreeProvider(home);
      const world = await provider.create({ taskId: 'remote1', repo: source, base: 'main', target: 'main' });
      expect(await world.readFile('README.md')).toBe('# remote\n');
      expect(world.handle.repos?.[0]).toMatchObject({ source, target: 'main' });
      expect(world.handle.repo).toContain(path.join(home, '.repositories'));
      expect((await git(world.handle.repo!, ['remote', 'get-url', 'origin'])).stdout.trim()).toBe(source);
      await world.destroy();
      expect(await isGitRepoForTest(world.handle.repo!)).toBe(true);
    } finally {
      fs.rmSync(seed, { recursive: true, force: true });
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  it('creates a plain non-Git workspace when no repo is configured', async () => {
    const provider = new WorktreeProvider(home);
    const world = await provider.create({ taskId: 'rp3', base: 'main' });
    expect(world.handle.repo).toBeUndefined();
    expect(world.handle.repos).toEqual([]);
    expect(fs.existsSync(path.join(world.handle.root, '.git'))).toBe(false);
    await world.destroy();
  });
});

async function isGitRepoForTest(dir: string): Promise<boolean> {
  const result = await git(dir, ['rev-parse', '--is-inside-work-tree']);
  return result.code === 0 && result.stdout.trim() === 'true';
}
