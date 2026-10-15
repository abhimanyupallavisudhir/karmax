import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { WorktreeProvider } from '../src/world/worktree.js';
import { finalizeMerge } from '../src/world/merge.js';
import { worldRepos } from '../src/world/types.js';
import { pullRequestHandle, pullRequestView, isPullRequestView } from '../src/world/pr-view.js';
import { git, gitOrThrow, ensureIdentity } from '../src/world/git.js';

/**
 * A pull request of a task with several branches (SPEC §11.1) is a snapshot of
 * one checkout, in a worktree of the SAME world, landed through a view of that
 * world narrowed to it. These pin what makes that safe: the view sees only the
 * snapshot, the world object is never changed by it, and landing it lands that
 * snapshot — not the agent's later commits, not its other branches.
 *
 * Real git, no Temporal.
 */
describe('a pull request seen as a view of its task\'s world', () => {
  let home: string;
  let repo: string;

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-prview-worlds-'));
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-prview-repos-'));
    repo = path.join(scratch, 'app');
    fs.mkdirSync(repo);
    await gitOrThrow(repo, ['init', '-q', '-b', 'main']);
    await ensureIdentity(repo);
    fs.writeFileSync(path.join(repo, 'a.js'), 'export const a = 1;\n');
    await gitOrThrow(repo, ['add', '-A']);
    await gitOrThrow(repo, ['commit', '-q', '-m', 'init']);
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(path.dirname(repo), { recursive: true, force: true }); });

  const commitIn = async (root: string, file: string, content: string) => {
    fs.writeFileSync(path.join(root, file), content);
    await gitOrThrow(root, ['add', '-A']);
    await gitOrThrow(root, ['commit', '-q', '-m', file]);
  };

  it('lands exactly the snapshot, while the agent goes on in its checkout', async () => {
    const world = await new WorktreeProvider(home).create({ taskId: 't-pr', repo, base: 'main', target: 'main', layout: 'nested' });
    await world.addCheckout!({ name: 'docs' });
    const [main, docs] = worldRepos(world.handle);
    await commitIn(docs!.root, 'guide.md', '# guide\n');
    await commitIn(main!.root, 'feature.js', 'export const f = 1;\n');
    const shipped = await gitOrThrow(docs!.root, ['rev-parse', 'HEAD']);

    // The snapshot: a worktree on the pull request's own branch at the shipped commit.
    const view = pullRequestHandle(world.handle, docs!, 'task_child', 'main');
    await gitOrThrow(docs!.root, ['worktree', 'add', '-q', '-B', view.repos![0]!.branch, view.repos![0]!.root, shipped]);
    expect(view.id).toBe('t-pr');
    expect(view.branch).toBe('tavya/task_child');
    expect(view.repos!.map((r) => r.name)).toEqual(['docs']);
    expect(view.repos![0]!.root).toBe(path.join(world.handle.root, '.karmax-injection', 'pull-requests', 'task_child'));
    expect(isPullRequestView(view)).toBe(true);
    expect(isPullRequestView(world.handle)).toBe(false);

    // The agent keeps working in its own checkout after shipping.
    await commitIn(docs!.root, 'draft.md', 'not reviewed\n');

    const seen = pullRequestView(world, view);
    expect(worldRepos(seen.handle).map((r) => r.name)).toEqual(['docs']);
    // The shared world object is untouched: the task still sees all its branches.
    expect(worldRepos(world.handle).map((r) => r.name)).toEqual([main!.name, 'docs']);

    const landed = await finalizeMerge(seen, 'main');
    expect(landed.merged).toBe(true);
    expect((await git(repo, ['show', 'main:guide.md'])).code).toBe(0);
    // Neither the agent's later commit nor its other branch came with it.
    expect((await git(repo, ['show', 'main:draft.md'])).code).not.toBe(0);
    expect((await git(repo, ['show', 'main:feature.js'])).code).not.toBe(0);
    expect((await git(repo, ['log', '--oneline', 'main'])).stdout).toContain('merge tavya/task_child into main');
    await world.destroy();
  });
});
