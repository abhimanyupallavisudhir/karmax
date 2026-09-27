import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
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

  it('waits for a canonical wiki mutation in another process before landing (WD-26)', async () => {
    const world = await new WorktreeProvider(home).create({ taskId: 'wiki-lane', repo, base: 'main', target: 'main' });
    world.handle.repos![0]!.role = 'project-wiki';
    await world.writeFile('task-memory.md', 'task memory\n');
    await gitOrThrow(world.handle.root, ['add', '-A']);
    await gitOrThrow(world.handle.root, ['commit', '-q', '-m', 'task memory']);
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { mutateAndPublishProjectWiki } from './src/wiki/repository.ts';
      await mutateAndPublishProjectWiki(process.argv[1], () => {}, async () => {
        process.send('held');
        await new Promise(resolve => process.once('message', resolve));
      });
      process.disconnect();
    `, repo], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = '';
    child.stderr!.on('data', chunk => { stderr += chunk; });
    const exited = once(child, 'exit');
    let landing: ReturnType<typeof finalizeMerge> | undefined;
    try {
      await Promise.race([once(child, 'message'), exited.then(() => { throw new Error(stderr || 'wiki writer exited early'); })]);
      landing = finalizeMerge(world, 'main');
      expect(await Promise.race([landing.then(() => 'landed'),
        new Promise(resolve => setTimeout(() => resolve('waiting'), 1000))])).toBe('waiting');
      child.send('release');
      expect((await landing).merged).toBe(true);
      expect((await git(repo, ['show', 'main:task-memory.md'])).stdout).toBe('task memory\n');
    } finally {
      if (child.connected) child.send('release');
      await exited;
      await landing;
      await world.destroy();
    }
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

  it.each(['corrected', 'legacy'])('lands work and reports files after a missing base (%s metadata)', async (metadata) => {
    const provider = new WorktreeProvider(home);
    // Setup now resolves the missing base and reports the correction immediately.
    const world = await provider.create({ taskId: 'nobase1', repo, base: 'develop', target: 'main' });
    expect(world.handle).toMatchObject({ base: 'main', target: 'main' });
    expect(world.handle.warnings?.join('\n')).toContain('Base branch changed to "main" because "develop" did not exist');
    expect(world.handle.repos![0]).toMatchObject({ base: 'main', target: 'main' });
    if (metadata === 'legacy') {
      // Persisted worlds from before setup corrections still need the merge fallback.
      world.handle.base = world.handle.repos![0]!.base = 'develop';
      delete world.handle.repos![0]!.branchAdjustment;
    }
    await world.writeFile('factorial.js', 'export const f = (n) => (n <= 1 ? 1 : n * f(n - 1));\n');
    await git(world.handle.root, ['add', '-A']);
    await git(world.handle.root, ['commit', '-q', '-m', 'work']);

    const res = await finalizeMerge(world, 'main');
    expect(res.merged).toBe(true);
    // The landed-files report must not be silently blanked by a failed base diff.
    expect(res.landedFiles).toContain('factorial.js');
    if (metadata === 'legacy') expect(res.note).toMatch(/base "develop" not found/);
    else {
      expect(res.note).toBeUndefined();
      expect(res.landedFiles).toEqual(['factorial.js']);
    }
    const onMain = await git(repo, ['show', 'main:factorial.js']);
    expect(onMain.stdout).toContain('export const f');
    await world.destroy();
  });

  it.each(['corrected', 'legacy'])('rejects committed conflict markers after a missing base (%s metadata)', async (metadata) => {
    const provider = new WorktreeProvider(home);
    const world = await provider.create({ taskId: 'nobase2', repo, base: 'develop', target: 'main' });
    if (metadata === 'legacy') {
      world.handle.base = world.handle.repos![0]!.base = 'develop';
      delete world.handle.repos![0]!.branchAdjustment;
    }
    // an agent "resolved" a conflict by committing the markers as content
    await world.writeFile('index.js', '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> main\n');
    await git(world.handle.root, ['add', '-A']);
    await git(world.handle.root, ['commit', '-q', '-m', 'bad resolution']);

    const res = await finalizeMerge(world, 'main');
    // Both corrected checkouts and historical unresolved bases retain the marker guard.
    expect(res.merged).toBe(false);
    expect(res.conflict).toContain('index.js');
    const onMain = await git(repo, ['show', 'main:index.js']);
    expect(onMain.stdout).not.toContain('<<<<<<<');
    await world.destroy();
  });

  it('skips an unchanged project wiki when its canonical checkout is dirty', async () => {
    const wiki = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-wiki-'));
    await gitOrThrow(wiki, ['init', '-q', '-b', 'main']);
    await ensureIdentity(wiki);
    fs.writeFileSync(path.join(wiki, 'MEMORY.md'), 'canonical memory\n');
    await git(wiki, ['add', '-A']);
    await git(wiki, ['commit', '-q', '-m', 'init wiki']);

    const provider = new WorktreeProvider(home);
    const world = await provider.create({
      taskId: 'wiki-noop',
      repos: [repo, wiki],
      base: 'main',
      target: 'main',
      repositoryBranches: {
        [repo]: { base: 'main', target: 'main' },
        [wiki]: { base: 'main', target: 'main' },
      },
    });
    const source = world.handle.repos!.find((candidate) => candidate.repo === repo)!;
    const companion = world.handle.repos!.find((candidate) => candidate.repo === wiki)!;
    companion.role = 'project-wiki';

    try {
      fs.writeFileSync(path.join(source.root, 'feature.js'), 'export const feature = true;\n');
      await git(source.root, ['add', '-A']);
      await git(source.root, ['commit', '-q', '-m', 'source work']);

      // This is unrelated canonical wiki work. It must remain untouched, and an
      // unchanged task wiki branch must not prevent the source repo from landing.
      fs.writeFileSync(path.join(wiki, 'MEMORY.md'), 'uncommitted canonical edit\n');
      const result = await finalizeMerge(world, 'main');

      expect(result.merged).toBe(true);
      expect((await git(repo, ['show', 'main:feature.js'])).stdout).toContain('feature');
      expect(fs.readFileSync(path.join(wiki, 'MEMORY.md'), 'utf8')).toBe('uncommitted canonical edit\n');
      expect((await git(wiki, ['status', '--porcelain'])).stdout).toContain('MEMORY.md');
    } finally {
      await world.destroy();
      fs.rmSync(wiki, { recursive: true, force: true });
    }
  });

  it('still blocks a changed project wiki on a dirty canonical checkout and labels it clearly', async () => {
    const wiki = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-wiki-'));
    await gitOrThrow(wiki, ['init', '-q', '-b', 'main']);
    await ensureIdentity(wiki);
    fs.writeFileSync(path.join(wiki, 'MEMORY.md'), 'canonical memory\n');
    await git(wiki, ['add', '-A']);
    await git(wiki, ['commit', '-q', '-m', 'init wiki']);

    const provider = new WorktreeProvider(home);
    const world = await provider.create({
      taskId: 'wiki-changed',
      repos: [repo, wiki],
      base: 'main',
      target: 'main',
    });
    const companion = world.handle.repos!.find((candidate) => candidate.repo === wiki)!;
    companion.role = 'project-wiki';

    try {
      fs.writeFileSync(path.join(companion.root, 'task-memory.md'), 'task wiki edit\n');
      await git(companion.root, ['add', '-A']);
      await git(companion.root, ['commit', '-q', '-m', 'task wiki work']);
      fs.writeFileSync(path.join(wiki, 'MEMORY.md'), 'uncommitted canonical edit\n');

      const result = await finalizeMerge(world, 'main');

      expect(result.merged).toBe(false);
      expect(result.note).toMatch(/^project wiki ".+": target "main" worktree has uncommitted changes/);
      expect((await git(wiki, ['show', 'main:task-memory.md'])).code).not.toBe(0);
    } finally {
      await world.destroy();
      fs.rmSync(wiki, { recursive: true, force: true });
    }
  });
});
