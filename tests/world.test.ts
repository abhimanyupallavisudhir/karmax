import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { WorktreeProvider } from '../src/world/worktree.js';
import { git, gitOrThrow, currentBranch, ensureIdentity } from '../src/world/git.js';

describe('WorktreeProvider (real git)', () => {
  let home: string;
  let repo: string;
  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-worlds-'));
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-repo-'));
    await gitOrThrow(repo, ['init', '-q', '-b', 'main']);
    await ensureIdentity(repo);
    fs.writeFileSync(path.join(repo, 'index.js'), 'console.log(1)\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-q', '-m', 'init']);
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('creates an isolated worktree on a karmax branch off the base', async () => {
    const provider = new WorktreeProvider(home);
    const world = await provider.create({ taskId: 'abc', repo, base: 'main', target: 'main' });
    expect(world.handle.branch).toBe('karmax/abc');
    expect(fs.existsSync(world.handle.root)).toBe(true);
    expect(await currentBranch(world.handle.root)).toBe('karmax/abc');
    // base file is present in the worktree
    expect(await world.readFile('index.js')).toContain('console.log');
    await world.destroy();
    expect(fs.existsSync(world.handle.root)).toBe(false);
    // branch is preserved after destroy
    expect((await git(repo, ['rev-parse', '--verify', 'karmax/abc'])).code).toBe(0);
  });

  it('creates a scratch repo when no repo is given', async () => {
    const provider = new WorktreeProvider(home);
    const world = await provider.create({ taskId: 'scratch1', base: 'main' });
    expect(fs.existsSync(world.handle.root)).toBe(true);
    expect(world.handle.repo).toBeTruthy();
    await world.writeFile('hello.txt', 'hi');
    expect(await world.readFile('hello.txt')).toBe('hi');
    const files = await world.listFiles();
    expect(files).toContain('hello.txt');
    await world.destroy();
  });

  it('exec runs commands in the world root', async () => {
    const provider = new WorktreeProvider(home);
    const world = await provider.create({ taskId: 'exec1', repo, base: 'main' });
    const r = await world.exec('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('karmax/exec1');
    await world.destroy();
  });

  it('links the origin node_modules into the world so the checkout can run itself', async () => {
    // Simulate an installed dependency in the origin repo.
    const dep = path.join(repo, 'node_modules', 'left-pad');
    fs.mkdirSync(dep, { recursive: true });
    fs.writeFileSync(path.join(dep, 'index.js'), 'module.exports = 1\n');
    const provider = new WorktreeProvider(home);
    const world = await provider.create({ taskId: 'deps1', repo, base: 'main' });
    // The world can resolve the origin's installed deps without a per-world install.
    const linked = path.join(world.handle.root, 'node_modules', 'left-pad', 'index.js');
    expect(fs.existsSync(linked)).toBe(true);
    expect(fs.readFileSync(linked, 'utf8')).toContain('module.exports');
    // The link must be git-ignored — a `node_modules/` rule matches dirs only,
    // not a symlink, so without an explicit exclude an agent could commit it.
    const others = await git(world.handle.root, ['ls-files', '--others', '--exclude-standard']);
    expect(others.stdout).not.toContain('node_modules');
    await world.destroy();
  });

  it('does not link node_modules when the origin has none (scratch/non-Node repo)', async () => {
    const provider = new WorktreeProvider(home);
    const world = await provider.create({ taskId: 'deps2', repo, base: 'main' });
    expect(fs.existsSync(path.join(world.handle.root, 'node_modules'))).toBe(false);
    await world.destroy();
  });

  it('copies named gitignored files into the world', async () => {
    fs.writeFileSync(path.join(repo, '.env'), 'SECRET=1\n');
    const provider = new WorktreeProvider(home);
    const world = await provider.create({ taskId: 'copy1', repo, base: 'main', copyGlobs: ['.env'] });
    expect(await world.readFile('.env')).toContain('SECRET=1');
    await world.destroy();
  });
});
