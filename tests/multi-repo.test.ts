import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { WorktreeProvider } from '../src/world/worktree.js';
import { finalizeMerge } from '../src/world/merge.js';
import { worldRepos } from '../src/world/types.js';
import { assemblePrompt } from '../src/agent/prompt.js';
import { git, gitOrThrow, currentBranch, ensureIdentity } from '../src/world/git.js';

/**
 * Multi-repo worlds: a project with several `repos` gives its agent ONE world
 * containing a worktree per repo (each in its own subdirectory), and the merge
 * lands work in every repo. These tests use real git, no Temporal.
 */

/** Make a git repo at <parent>/<name> with one committed file, return its path. */
async function makeRepo(parent: string, name: string, file: string, content: string): Promise<string> {
  const repo = path.join(parent, name);
  fs.mkdirSync(repo, { recursive: true });
  await gitOrThrow(repo, ['init', '-q', '-b', 'main']);
  await ensureIdentity(repo);
  fs.writeFileSync(path.join(repo, file), content);
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-q', '-m', 'init']);
  return repo;
}

describe('multi-repo worlds (real git)', () => {
  let home: string;
  let scratch: string;
  let alpha: string;
  let beta: string;

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-worlds-'));
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-repos-'));
    alpha = await makeRepo(scratch, 'alpha', 'a.js', 'export const a = 1;\n');
    beta = await makeRepo(scratch, 'beta', 'b.js', 'export const b = 2;\n');
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('checks out one worktree per repo under the world root, each on the karmax branch', async () => {
    const provider = new WorktreeProvider(home);
    const world = await provider.create({ taskId: 't1', repos: [alpha, beta], base: 'main', target: 'main' });

    // root is the PARENT dir (not itself a git repo); each repo is a subdirectory.
    expect(world.handle.repos).toHaveLength(2);
    expect(world.handle.repos!.map((r) => r.name)).toEqual(['alpha', 'beta']);
    expect(world.handle.repo).toBe(alpha); // primary = first repo (back-compat)
    for (const wr of world.handle.repos!) {
      expect(fs.existsSync(wr.root)).toBe(true);
      expect(path.dirname(wr.root)).toBe(world.handle.root);
      expect(await currentBranch(wr.root)).toBe('karmax/t1');
    }
    // each repo's base file is present in its own subdirectory
    expect(await world.readFile('alpha/a.js')).toContain('export const a');
    expect(await world.readFile('beta/b.js')).toContain('export const b');

    await world.destroy();
    expect(fs.existsSync(world.handle.root)).toBe(false);
    // branches are preserved in each source repo after destroy
    expect((await git(alpha, ['rev-parse', '--verify', 'karmax/t1'])).code).toBe(0);
    expect((await git(beta, ['rev-parse', '--verify', 'karmax/t1'])).code).toBe(0);
  });

  it('listFiles aggregates across repos, prefixed by the repo subdirectory', async () => {
    const provider = new WorktreeProvider(home);
    const world = await provider.create({ taskId: 't2', repos: [alpha, beta], base: 'main' });
    await world.writeFile('alpha/new-a.js', 'x');
    await world.writeFile('beta/new-b.js', 'y');
    const files = await world.listFiles();
    expect(files).toContain('alpha/a.js');
    expect(files).toContain('beta/b.js');
    expect(files).toContain('alpha/new-a.js');
    expect(files).toContain('beta/new-b.js');
    await world.destroy();
  });

  it('finalizeMerge lands work in EVERY repo (files prefixed by repo name)', async () => {
    const provider = new WorktreeProvider(home);
    const world = await provider.create({ taskId: 't3', repos: [alpha, beta], base: 'main', target: 'main' });
    // agent edits both repos but commits neither (mirrors the real failure mode)
    await world.writeFile('alpha/feature.js', 'export const fa = () => 42;\n');
    await world.writeFile('beta/feature.js', 'export const fb = () => 7;\n');

    const res = await finalizeMerge(world, 'main');
    expect(res.merged).toBe(true);
    expect(res.landedFiles).toContain('alpha/feature.js');
    expect(res.landedFiles).toContain('beta/feature.js');

    // the work is really on main in BOTH source repos
    expect((await git(alpha, ['show', 'main:feature.js'])).stdout).toContain('fa');
    expect((await git(beta, ['show', 'main:feature.js'])).stdout).toContain('fb');
    // a real merge commit exists in each
    expect((await git(alpha, ['log', '--oneline', 'main'])).stdout).toMatch(/merge karmax\/t3 into main/);
    expect((await git(beta, ['log', '--oneline', 'main'])).stdout).toMatch(/merge karmax\/t3 into main/);
    await world.destroy();
  });

  it('stops at the first conflicting repo, names it, and re-merge after resolution lands everything', async () => {
    const provider = new WorktreeProvider(home);
    const world = await provider.create({ taskId: 't4', repos: [alpha, beta], base: 'main', target: 'main' });
    // alpha: a clean change that will land. beta: a change that conflicts with a
    // divergent main (target moved on the same line under the world).
    await world.writeFile('alpha/feature.js', 'export const ok = true;\n');
    await world.writeFile('beta/b.js', 'export const b = 99;\n');
    fs.writeFileSync(path.join(beta, 'b.js'), 'export const b = 100;\n');
    await git(beta, ['add', '-A']);
    await git(beta, ['commit', '-q', '-m', 'diverge on beta']);

    const first = await finalizeMerge(world, 'main');
    expect(first.merged).toBe(false);
    expect(first.note).toContain('beta'); // the offending repo is named
    expect(first.conflict).toBeTruthy();
    // alpha landed (partial merge is recoverable, not atomic) …
    expect((await git(alpha, ['show', 'main:feature.js'])).stdout).toContain('ok');
    // … beta's main is untouched (not corrupted with markers)
    expect((await git(beta, ['show', 'main:b.js'])).stdout).toContain('100');
    expect((await git(beta, ['show', 'main:b.js'])).stdout).not.toContain('<<<<<<<');

    // the merge agent resolves beta's conflict the real way: merge the target into
    // the branch, fix the conflicted file, and commit the merge.
    const betaWt = world.handle.repos![1]!.root;
    expect((await git(betaWt, ['merge', 'main'])).code).not.toBe(0); // sanity: conflicts
    await world.writeFile('beta/b.js', 'export const b = 199;\n');
    await git(betaWt, ['add', '-A']);
    await git(betaWt, ['commit', '--no-edit', '-q']);

    const second = await finalizeMerge(world, 'main');
    expect(second.merged).toBe(true); // alpha re-merges as a no-op; beta now lands
    expect((await git(beta, ['show', 'main:b.js'])).stdout).toContain('199');
    await world.destroy();
  });

  it('disambiguates colliding repo basenames (app, app-2)', async () => {
    // two distinct repos that happen to share a basename "app"
    const a1 = await makeRepo(path.join(scratch, 'one'), 'app', 'x.js', '// one\n');
    const a2 = await makeRepo(path.join(scratch, 'two'), 'app', 'y.js', '// two\n');
    const provider = new WorktreeProvider(home);
    const world = await provider.create({ taskId: 't5', repos: [a1, a2], base: 'main' });
    expect(world.handle.repos!.map((r) => r.name)).toEqual(['app', 'app-2']);
    expect(await world.readFile('app/x.js')).toContain('one');
    expect(await world.readFile('app-2/y.js')).toContain('two');
    await world.destroy();
  });

  it('a single-repo project keeps the legacy layout (root IS the worktree)', async () => {
    const provider = new WorktreeProvider(home);
    const world = await provider.create({ taskId: 's1', repos: [alpha], base: 'main', target: 'main' });
    // root is the worktree itself — files live at the top level, not under a subdir.
    expect(world.handle.repos).toHaveLength(1);
    expect(world.handle.repos![0]!.root).toBe(world.handle.root);
    expect(world.handle.repo).toBe(alpha);
    expect(await world.readFile('a.js')).toContain('export const a');
    const files = await world.listFiles();
    expect(files).toContain('a.js');
    expect(files).not.toContain('alpha/a.js');
    await world.destroy();
  });

  it('the legacy `repo` spec field still works (single repo)', async () => {
    const provider = new WorktreeProvider(home);
    const world = await provider.create({ taskId: 's2', repo: alpha, base: 'main' });
    expect(world.handle.repos).toHaveLength(1);
    expect(world.handle.root).toBe(world.handle.repos![0]!.root);
    await world.writeFile('extra.js', '1');
    const res = await finalizeMerge(world, 'main');
    expect(res.merged).toBe(true);
    expect(res.landedFiles).toContain('extra.js'); // NOT prefixed for a single repo
    await world.destroy();
  });
});

describe('worldRepos() tolerates handles predating repos[]', () => {
  it('synthesizes a single-repo list from the top-level fields', () => {
    const legacy = { kind: 'worktree', id: 'x', root: '/w/x', branch: 'karmax/x', base: 'main', repo: '/src/proj' } as any;
    const repos = worldRepos(legacy);
    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({ name: 'proj', repo: '/src/proj', root: '/w/x', branch: 'karmax/x', base: 'main' });
  });
  it('returns [] for a non-git (scratch-less) handle', () => {
    const mem = { kind: 'memory', id: 'm', root: '/tmp/m', branch: 'karmax/m', base: 'main' } as any;
    expect(worldRepos(mem)).toEqual([]);
  });
  it('prefers repos[] when present', () => {
    const h = { kind: 'worktree', id: 'x', root: '/w', branch: 'b', base: 'main', repo: '/a', repos: [{ name: 'a', repo: '/a', root: '/w/a', branch: 'b', base: 'main' }, { name: 'c', repo: '/c', root: '/w/c', branch: 'b', base: 'main' }] } as any;
    expect(worldRepos(h)).toHaveLength(2);
  });
});

describe('prompt assembly surfaces the multi-repo layout', () => {
  const task = { taskId: 't', projectId: 'p', title: 'Wire A to B', prompt: 'do it' } as any;
  const profile = (over: any = {}) => ({ id: 'do', name: 'Do', provider: 'claude', role: 'do', capabilities: [], ...over } as any);

  it('describes each repo subdirectory for a multi-repo world', () => {
    const world = {
      kind: 'worktree', id: 't', root: '/w/t', branch: 'karmax/t', base: 'main', target: 'main', repo: '/src/frontend',
      repos: [
        { name: 'frontend', repo: '/src/frontend', root: '/w/t/frontend', branch: 'karmax/t', base: 'main' },
        { name: 'backend', repo: '/src/backend', root: '/w/t/backend', branch: 'karmax/t', base: 'main' },
      ],
    } as any;
    const out = assemblePrompt({ profile: profile(), role: 'do', task, world });
    expect(out).toContain('spans 2 repositories');
    expect(out).toContain('frontend/');
    expect(out).toContain('backend/');
  });

  it('adds no repo block for a single-repo world', () => {
    const world = { kind: 'worktree', id: 't', root: '/w/t', branch: 'karmax/t', base: 'main', target: 'main', repo: '/src/only', repos: [{ name: 'only', repo: '/src/only', root: '/w/t', branch: 'karmax/t', base: 'main' }] } as any;
    const out = assemblePrompt({ profile: profile(), role: 'do', task, world });
    expect(out).not.toContain('spans');
    expect(out).toContain('Working directory: /w/t');
  });
});
