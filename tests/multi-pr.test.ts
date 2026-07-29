import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { WorktreeProvider } from '../src/world/worktree.js';
import { finalizeMerge } from '../src/world/merge.js';
import { worldRepos } from '../src/world/types.js';
import { mergeQueueDomains } from '../src/domain/types.js';
import { git, gitOrThrow, ensureIdentity } from '../src/world/git.js';

/**
 * Multi-PR tasks: one task, one world, one Do agent — but the change is
 * partitioned into SEVERAL branches, each landing on its own target as its own
 * pull request. A checkout is already `(source repo, dir, branch, base, target)`
 * (`WorldRepo`), so "several PRs" is just "several checkouts", including two of
 * the SAME repo. These tests pin the three properties that makes true:
 *
 *  1. a world can hold two branches of one repo, and the merge lands both;
 *  2. those two branches take ONE merge-queue slot (the domain is per repo:target,
 *     so a task never queues behind itself and the deadlock-free ordered
 *     acquisition of SPEC §6.1 is unchanged);
 *  3. a checkout stacked on a sibling merges AFTER it, so each branch's PR
 *     carries only its own change.
 *
 * Real git, no Temporal.
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

/** Commit `file` inside one checkout of the world (what the Do agent does). */
async function commitIn(root: string, file: string, content: string, message: string) {
  fs.writeFileSync(path.join(root, file), content);
  await git(root, ['add', '-A']);
  await gitOrThrow(root, ['commit', '-q', '-m', message]);
}

describe('multi-PR tasks (several branches in one world, real git)', () => {
  let home: string;
  let scratch: string;
  let repo: string;

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-worlds-'));
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-repos-'));
    repo = await makeRepo(scratch, 'alpha', 'a.js', 'export const a = 1;\n');
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('nests the primary checkout so later branches have somewhere to live', async () => {
    const provider = new WorktreeProvider(home);
    const world = await provider.create({ taskId: 't-nest', repo, base: 'main', target: 'main', layout: 'nested' });

    // The world root is the PARENT dir; the repo sits in a subdirectory, exactly
    // as in a multi-repo world. A flat single-repo world has nowhere to put a
    // second checkout except inside the first one's working tree.
    const repos = worldRepos(world.handle);
    expect(repos).toHaveLength(1);
    expect(repos[0]!.root).toBe(path.join(world.handle.root, 'alpha'));
    expect(world.handle.workdir).toBe(repos[0]!.root);
    await world.destroy();
  });

  it('adds a second branch of the SAME repo and lands both on the target', async () => {
    const provider = new WorktreeProvider(home);
    const world = await provider.create({ taskId: 't-two', repo, base: 'main', target: 'main', layout: 'nested' });

    // The Do agent decides the change is better as two PRs and asks for a
    // second checkout of the same repo, on its own branch.
    const handle = await world.addCheckout!({ name: 'docs' });
    const repos = worldRepos(handle);
    expect(repos).toHaveLength(2);
    expect(repos[1]!.name).toBe('docs');
    expect(repos[1]!.repo).toBe(repos[0]!.repo);            // same source repo…
    expect(repos[1]!.branch).not.toBe(repos[0]!.branch);    // …different branch
    expect(repos[1]!.branch).toBe('karmax/t-two-docs');
    expect(repos[1]!.root).toBe(path.join(handle.root, 'docs'));

    await commitIn(repos[0]!.root, 'feature.js', 'export const f = 1;\n', 'feat');
    await commitIn(repos[1]!.root, 'README.md', '# docs\n', 'docs');

    const res = await finalizeMerge(world, 'main');
    expect(res.merged).toBe(true);
    expect(res.landedFiles).toContain('alpha/feature.js');
    expect(res.landedFiles).toContain('docs/README.md');

    // Both branches really landed on main, each through its own merge commit —
    // i.e. two reviewable units, not one squashed blob.
    expect((await git(repo, ['show', 'main:feature.js'])).code).toBe(0);
    expect((await git(repo, ['show', 'main:README.md'])).code).toBe(0);
    const log = (await git(repo, ['log', '--oneline', 'main'])).stdout;
    expect(log).toMatch(/merge karmax\/t-two into main/);
    expect(log).toMatch(/merge karmax\/t-two-docs into main/);
    await world.destroy();
  });

  it('collapses both branches of a repo into ONE merge-queue slot', async () => {
    const provider = new WorktreeProvider(home);
    const world = await provider.create({ taskId: 't-queue', repo, base: 'main', target: 'main', layout: 'nested' });
    const handle = await world.addCheckout!({ name: 'docs' });

    // The queue serializes access to (repo, target). Two branches of one repo
    // are still one contended resource, so the task takes exactly one slot —
    // it can never wait behind itself, and ordered acquisition is unchanged.
    expect(mergeQueueDomains(handle, 'main', 'proj')).toHaveLength(1);
    await world.destroy();
  });

  it('merges a stacked checkout after the sibling it is based on', async () => {
    const provider = new WorktreeProvider(home);
    const world = await provider.create({ taskId: 't-stack', repo, base: 'main', target: 'main', layout: 'nested' });

    // `base` naming a sibling checkout is a stacked PR: `api` builds on `core`.
    await world.addCheckout!({ name: 'api', base: 'alpha' });
    const handle = world.handle;
    const [core, api] = worldRepos(handle);
    expect(api!.base).toBe(core!.branch);

    await commitIn(core!.root, 'core.js', 'export const core = 1;\n', 'core');
    await commitIn(api!.root, 'api.js', 'export const api = 2;\n', 'api');

    const res = await finalizeMerge(world, 'main');
    expect(res.merged).toBe(true);

    // Order is the point: if `api` landed first it would drag `core`'s commits in
    // with it, and core's PR would show up already-merged with nothing of its own.
    const firstParent = (await git(repo, ['log', '--oneline', '--first-parent', 'main'])).stdout
      .split('\n').filter(Boolean);
    const coreAt = firstParent.findIndex((l) => l.includes(`merge ${core!.branch} into main`));
    const apiAt = firstParent.findIndex((l) => l.includes(`merge ${api!.branch} into main`));
    expect(coreAt).toBeGreaterThanOrEqual(0);
    expect(apiAt).toBeGreaterThanOrEqual(0);
    expect(coreAt).toBeGreaterThan(apiAt); // newest first ⇒ core is older ⇒ core merged first
    await world.destroy();
  });

  it('refuses a second checkout in a flat world rather than nesting it inside the first', async () => {
    const provider = new WorktreeProvider(home);
    const world = await provider.create({ taskId: 't-flat', repo, base: 'main', target: 'main' });
    expect(worldRepos(world.handle)[0]!.root).toBe(world.handle.root); // flat: root IS the worktree
    await expect(world.addCheckout!({ name: 'docs' })).rejects.toThrow(/nested/i);
    await world.destroy();
  });

  it('rejects a duplicate checkout name', async () => {
    const provider = new WorktreeProvider(home);
    const world = await provider.create({ taskId: 't-dup', repo, base: 'main', target: 'main', layout: 'nested' });
    await expect(world.addCheckout!({ name: 'alpha' })).rejects.toThrow(/already/i);
    await world.destroy();
  });
});
