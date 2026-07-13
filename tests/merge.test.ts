import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { WorktreeProvider } from '../src/world/worktree.js';
import { finalizeMerge } from '../src/world/merge.js';
import { git, gitOrThrow, ensureIdentity } from '../src/world/git.js';

describe('finalizeMerge (work must actually land)', () => {
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

  it('rejects uncommitted work back to the merge agent instead of sweeping it', async () => {
    const provider = new WorktreeProvider(home);
    const world = await provider.create({ taskId: 'land1', repo, base: 'main', target: 'main' });
    // agent writes a file but does NOT commit (mirrors the real failure mode)
    await world.writeFile('factorial.js', 'export const f = (n) => (n <= 1 ? 1 : n * f(n - 1));\n');

    // Commit-vs-gitignore is the merge agent's call (PLAN-git-config.md §6):
    // the dirty tree is rejected with the file list, and nothing lands.
    const res = await finalizeMerge(world, 'main');
    expect(res.merged).toBe(false);
    expect(res.dirty).toContain('factorial.js');
    expect((await git(repo, ['show', 'main:factorial.js'])).code).not.toBe(0);

    // The loop-back contract: once the merge agent commits, the re-run lands it.
    await git(world.handle.root, ['add', '-A']);
    await git(world.handle.root, ['commit', '-q', '-m', 'work']);
    const res2 = await finalizeMerge(world, 'main');
    expect(res2.merged).toBe(true);
    expect(res2.sha).toMatch(/^[0-9a-f]{7,}/);
    expect(res2.landedFiles).toContain('factorial.js');

    // the file is really on main in the source repo
    const onMain = await git(repo, ['show', 'main:factorial.js']);
    expect(onMain.code).toBe(0);
    expect(onMain.stdout).toContain('export const f');
    // a real merge commit exists (point of no return)
    const log = await git(repo, ['log', '--oneline', 'main']);
    expect(log.stdout).toMatch(/merge karmax\/land1 into main/);
    await world.destroy();
  });

  it('reports a conflict instead of corrupting the target', async () => {
    const provider = new WorktreeProvider(home);
    const world = await provider.create({ taskId: 'conf1', repo, base: 'main', target: 'main' });
    // change index.js in the attempt (committed — dirtiness is tested elsewhere)
    await world.writeFile('index.js', 'console.log("attempt")\n');
    await git(world.handle.root, ['add', '-A']);
    await git(world.handle.root, ['commit', '-q', '-m', 'attempt']);
    // meanwhile main diverges on the same line
    fs.writeFileSync(path.join(repo, 'index.js'), 'console.log("mainline")\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-q', '-m', 'diverge']);

    const res = await finalizeMerge(world, 'main');
    expect(res.merged).toBe(false);
    expect(res.conflict).toBeTruthy();
    // main is untouched (still the diverged content, not corrupted)
    const onMain = await git(repo, ['show', 'main:index.js']);
    expect(onMain.stdout).toContain('mainline');
    await world.destroy();
  });

  it('refuses to land a worktree left in a conflicted half-merge (agent died mid-merge)', async () => {
    const provider = new WorktreeProvider(home);
    const world = await provider.create({ taskId: 'halfmerge', repo, base: 'main', target: 'main' });
    const root = world.handle.root;
    // the agent commits a conflicting change on the branch…
    await world.writeFile('index.js', 'console.log("attempt")\n');
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-q', '-m', 'attempt work']);
    // …meanwhile main diverges on the same line
    fs.writeFileSync(path.join(repo, 'index.js'), 'console.log("mainline")\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-q', '-m', 'diverge']);
    // a merge agent starts `git merge main`, hits the conflict, and its turn dies
    // mid-merge — MERGE_HEAD and conflict hunks are left sitting in the worktree
    const m = await git(root, ['merge', 'main']);
    expect(m.code).not.toBe(0); // sanity: we really are mid-conflict

    const res = await finalizeMerge(world, 'main');
    expect(res.merged).toBe(false);
    expect(res.conflict).toContain('index.js');
    // the half-merge was NOT "completed" into a commit carrying the markers
    const branchTip = await git(root, ['show', 'HEAD:index.js']);
    expect(branchTip.stdout).not.toContain('<<<<<<<');
    // and main is untouched
    const onMain = await git(repo, ['show', 'main:index.js']);
    expect(onMain.stdout).toContain('mainline');
    expect(onMain.stdout).not.toContain('<<<<<<<');
    await world.destroy();
  });

  it('refuses to land committed conflict markers', async () => {
    const provider = new WorktreeProvider(home);
    const world = await provider.create({ taskId: 'markers1', repo, base: 'main', target: 'main' });
    // an agent "resolved" a conflict by committing the markers as content
    await world.writeFile('index.js', '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> main\n');
    await git(world.handle.root, ['add', '-A']);
    await git(world.handle.root, ['commit', '-q', '-m', 'bad resolution']);

    const res = await finalizeMerge(world, 'main');
    expect(res.merged).toBe(false);
    expect(res.conflict).toContain('index.js');
    const onMain = await git(repo, ['show', 'main:index.js']);
    expect(onMain.stdout).not.toContain('<<<<<<<');
    await world.destroy();
  });

  it('completes a merge the agent resolved but forgot to commit', async () => {
    const provider = new WorktreeProvider(home);
    const world = await provider.create({ taskId: 'resolved1', repo, base: 'main', target: 'main' });
    const root = world.handle.root;
    await world.writeFile('index.js', 'console.log("attempt")\n');
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-q', '-m', 'attempt work']);
    fs.writeFileSync(path.join(repo, 'index.js'), 'console.log("mainline")\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-q', '-m', 'diverge']);
    await git(root, ['merge', 'main']); // conflicts
    // the agent resolves the conflict and stages it, but its turn ends pre-commit
    await world.writeFile('index.js', 'console.log("resolved")\n');
    await git(root, ['add', 'index.js']);

    const res = await finalizeMerge(world, 'main');
    expect(res.merged).toBe(true);
    const onMain = await git(repo, ['show', 'main:index.js']);
    expect(onMain.stdout).toContain('resolved');
    expect(onMain.stdout).not.toContain('<<<<<<<');
    await world.destroy();
  });

  it('still lands work and reports files when the configured base branch does not exist', async () => {
    const provider = new WorktreeProvider(home);
    // base "develop" is not a ref — world creation forks off HEAD instead.
    const world = await provider.create({ taskId: 'nobase1', repo, base: 'develop', target: 'main' });
    await world.writeFile('factorial.js', 'export const f = (n) => (n <= 1 ? 1 : n * f(n - 1));\n');
    await git(world.handle.root, ['add', '-A']);
    await git(world.handle.root, ['commit', '-q', '-m', 'work']);

    const res = await finalizeMerge(world, 'main');
    expect(res.merged).toBe(true);
    // The landed-files report must not be silently blanked by a failed base diff.
    expect(res.landedFiles).toContain('factorial.js');
    // The misconfiguration is surfaced rather than swallowed.
    expect(res.note).toMatch(/base "develop" not found/);
    const onMain = await git(repo, ['show', 'main:factorial.js']);
    expect(onMain.stdout).toContain('export const f');
    await world.destroy();
  });

  it('still catches committed conflict markers when the configured base branch does not exist', async () => {
    const provider = new WorktreeProvider(home);
    const world = await provider.create({ taskId: 'nobase2', repo, base: 'develop', target: 'main' });
    // an agent "resolved" a conflict by committing the markers as content
    await world.writeFile('index.js', '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> main\n');
    await git(world.handle.root, ['add', '-A']);
    await git(world.handle.root, ['commit', '-q', '-m', 'bad resolution']);

    const res = await finalizeMerge(world, 'main');
    // The marker guard must still run even though the base ref is unresolvable.
    expect(res.merged).toBe(false);
    expect(res.conflict).toContain('index.js');
    const onMain = await git(repo, ['show', 'main:index.js']);
    expect(onMain.stdout).not.toContain('<<<<<<<');
    await world.destroy();
  });
});
