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

  it('commits pending work and lands it on the target branch', async () => {
    const provider = new WorktreeProvider(home);
    const world = await provider.create({ taskId: 'land1', repo, base: 'main', target: 'main' });
    // agent writes a file but does NOT commit (mirrors the real failure mode)
    await world.writeFile('factorial.js', 'export const f = (n) => (n <= 1 ? 1 : n * f(n - 1));\n');

    const res = await finalizeMerge(world, 'main');
    expect(res.merged).toBe(true);
    expect(res.sha).toMatch(/^[0-9a-f]{7,}/);
    expect(res.landedFiles).toContain('factorial.js');

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
    // change index.js in the attempt
    await world.writeFile('index.js', 'console.log("attempt")\n');
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
});
