import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { WorktreeProvider } from '../src/world/worktree.js';
import { git, gitOrThrow, currentBranch, ensureIdentity } from '../src/world/git.js';
import { WorldRegistry } from '../src/world/registry.js';
import { Store } from '../src/store/db.js';
import { makeCoreActivities } from '../src/activities/core.js';
import { ProfileResolver } from '../src/agent/profiles.js';

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

  it('feeds ExecOptions.input to a command over stdin (secret channel for in-world fill)', async () => {
    const provider = new WorktreeProvider(home);
    const world = await provider.create({ taskId: 'stdin', repo, base: 'main', target: 'main' });
    try {
      // `cat` echoes stdin; the payload must NOT appear in argv.
      const res = await world.exec('cat', [], { input: 'sup3r-secret\n' });
      expect(res.code).toBe(0);
      expect(res.stdout).toBe('sup3r-secret\n');
      // a reader that only sees argv (no stdin) gets nothing
      const argvOnly = await world.exec('bash', ['-lc', 'echo "$@"', '--'], {});
      expect(argvOnly.stdout).not.toContain('sup3r-secret');
    } finally {
      await world.destroy();
    }
  });

  it('attaches the project wiki as a branch-and-merge companion repository', async () => {
    const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-content-'));
    const store = new Store(':memory:');
    const project = store.createProject('Wiki world', { repos: [repo], defaultBase: 'main', defaultTarget: 'main' });
    const task = store.createTask({ projectId: project.id, title: 'Edit both', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'x' } });
    const worlds = new WorldRegistry();
    worlds.register(new WorktreeProvider(home));
    const core = makeCoreActivities({ store, worlds, adapters: new Map(),
      profiles: new ProfileResolver(store, 'mock'), contentDir });
    try {
      const handle = await core.createWorld({ taskId: task.id, repos: [repo], base: 'main', target: 'main', kind: 'worktree' });
      expect(handle.repos).toHaveLength(2);
      expect(handle.repos!.find((candidate) => candidate.role === 'project-wiki')).toMatchObject({
        branch: `karmax/${task.id}`, base: 'main', target: 'main',
      });
      expect(handle.workdir).toBe(handle.repos!.find((candidate) => candidate.role !== 'project-wiki')!.root);
      await worlds.open(handle).then((world) => world.destroy());
    } finally {
      fs.rmSync(contentDir, { recursive: true, force: true });
      store.close();
    }
  });

  it('keeps a scratch workspace when the project wiki is the only configured repository', async () => {
    const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-content-'));
    const store = new Store(':memory:');
    const project = store.createProject('Wiki scratch', { repos: [], defaultBase: 'main', defaultTarget: 'main' });
    const task = store.createTask({ projectId: project.id, title: 'Scratch task', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'x' } });
    const worlds = new WorldRegistry();
    worlds.register(new WorktreeProvider(home));
    const core = makeCoreActivities({ store, worlds, adapters: new Map(),
      profiles: new ProfileResolver(store, 'mock'), contentDir });
    try {
      const handle = await core.createWorld({ taskId: task.id, base: 'main', target: 'main', kind: 'worktree' });
      expect(handle.repos).toHaveLength(2);
      expect(handle.repos!.some((candidate) => candidate.role === 'project-wiki')).toBe(true);
      expect(handle.repos!.find((candidate) => candidate.root === handle.workdir)?.name).toBe('scratch');
      const opened = await worlds.open(handle);
      expect((await opened.exec('pwd', [])).stdout.trim()).toBe(handle.workdir);
      await opened.destroy();
    } finally {
      fs.rmSync(contentDir, { recursive: true, force: true });
      store.close();
    }
  });

  it('warns (but still forks off HEAD) when the configured base branch does not exist', async () => {
    const provider = new WorktreeProvider(home);
    const world = await provider.create({ taskId: 'nobase', repo, base: 'develop', target: 'main' });
    // The world is still usable — it forked off HEAD.
    expect(await currentBranch(world.handle.root)).toBe('karmax/nobase');
    expect(await world.readFile('index.js')).toContain('console.log');
    // …but the ignored base is surfaced, not swallowed.
    expect(world.handle.warnings).toBeTruthy();
    expect(world.handle.warnings!.join('\n')).toMatch(/base branch "develop" not found/);
    await world.destroy();
  });

  it('does not warn when the configured base branch exists', async () => {
    const provider = new WorktreeProvider(home);
    const world = await provider.create({ taskId: 'okbase', repo, base: 'main', target: 'main' });
    expect(world.handle.warnings).toBeUndefined();
    await world.destroy();
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
    expect(world.handle.meta?.ephemeralPaths).toEqual(['.env']);
    await world.destroy();
  });
});
