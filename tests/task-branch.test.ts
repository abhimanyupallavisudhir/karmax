import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureIdentity, git, gitOrThrow } from '../src/world/git.js';
import { ensureTaskBranchAncestry } from '../src/world/task-branch.js';
import { WorktreeProvider } from '../src/world/worktree.js';

describe('task branch ancestry bookkeeping', () => {
  const cleanups: string[] = [];
  afterEach(() => { for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

  async function fixture(name: string) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `karmax-${name}-`));
    cleanups.push(root);
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    await gitOrThrow(repo, ['init', '-q', '-b', 'master']);
    await ensureIdentity(repo);
    fs.writeFileSync(path.join(repo, 'base.txt'), 'common\n');
    await gitOrThrow(repo, ['add', '-A']);
    await gitOrThrow(repo, ['commit', '-q', '-m', 'common base']);
    await gitOrThrow(repo, ['branch', 'karmax/parent']);
    const parentTree = path.join(root, 'parent-tree');
    await gitOrThrow(repo, ['worktree', 'add', '-q', parentTree, 'karmax/parent']);
    fs.writeFileSync(path.join(parentTree, 'parent.txt'), 'parent work\n');
    await gitOrThrow(parentTree, ['add', '-A']);
    await gitOrThrow(parentTree, ['commit', '-q', '-m', 'parent work']);
    const parent = (await gitOrThrow(parentTree, ['rev-parse', 'HEAD'])).trim();
    await gitOrThrow(repo, ['worktree', 'remove', '-f', parentTree]);
    fs.writeFileSync(path.join(repo, 'new-master.txt'), 'provisioning advanced\n');
    await gitOrThrow(repo, ['add', '-A']);
    await gitOrThrow(repo, ['commit', '-q', '-m', 'new master base']);
    const provisioned = (await gitOrThrow(repo, ['rev-parse', 'HEAD'])).trim();
    const provider = new WorktreeProvider(path.join(root, 'worlds'));
    const world = await provider.create({ taskId: name, repo, base: 'master', target: 'master' });
    return { root, repo, world, parent, provisioned };
  }

  it('records the parent task commit when a child targets the parent branch', async () => {
    const { root, repo, parent } = await fixture('stack-parent');
    const provider = new WorktreeProvider(path.join(root, 'worlds'));
    const child = await provider.create({ taskId: 'stack-child', repo,
      base: 'karmax/parent', target: 'karmax/parent' });
    expect(child.handle).toMatchObject({ base: 'karmax/parent', target: 'karmax/parent' });
    expect(child.handle.repos?.[0]).toMatchObject({
      base: 'karmax/parent', target: 'karmax/parent', baseSha: parent,
    });
  });

  it('repairs a resumeFrom recovery reset onto its selected parent without changing the candidate tree', async () => {
    const { world, parent, provisioned } = await fixture('resume-recovery');
    const checkout = world.handle.repos![0]!;
    expect(checkout.baseSha).toBe(provisioned);

    // Model #100: the resumed agent recovered the right tree, but replaced the
    // freshly provisioned task branch with the older parent proposal.
    await gitOrThrow(checkout.root, ['reset', '--hard', '-q', parent]);
    fs.writeFileSync(path.join(checkout.root, 'onboarding.txt'), 'exact recovered tree\n');
    await gitOrThrow(checkout.root, ['add', '-A']);
    await gitOrThrow(checkout.root, ['commit', '-q', '-m', 'recovered onboarding']);
    const beforeTree = (await gitOrThrow(checkout.root, ['rev-parse', 'HEAD^{tree}'])).trim();

    const result = await ensureTaskBranchAncestry(world, 'karmax/parent');
    expect(result.errors).toEqual({});
    expect(result.repaired).toEqual([expect.objectContaining({ repo: 'repo', baseSha: provisioned, targetSha: parent })]);
    expect((await gitOrThrow(checkout.root, ['rev-parse', 'HEAD^{tree}'])).trim()).toBe(beforeTree);
    expect((await git(checkout.root, ['merge-base', '--is-ancestor', provisioned, 'HEAD'])).code).toBe(0);
    expect((await git(checkout.root, ['merge-base', '--is-ancestor', parent, 'HEAD'])).code).toBe(0);
  });

  it('leaves a normally integrated parent-target branch unchanged', async () => {
    const { world, parent, provisioned } = await fixture('parent-child');
    const checkout = world.handle.repos![0]!;
    await gitOrThrow(checkout.root, ['merge', '-q', '--no-edit', parent]);
    const head = (await gitOrThrow(checkout.root, ['rev-parse', 'HEAD'])).trim();
    expect(await ensureTaskBranchAncestry(world, 'karmax/parent')).toEqual({ repaired: [], errors: {} });
    expect((await gitOrThrow(checkout.root, ['rev-parse', 'HEAD'])).trim()).toBe(head);
    expect((await git(checkout.root, ['merge-base', '--is-ancestor', provisioned, 'HEAD'])).code).toBe(0);
  });

  it('repairs work rebased onto the selected target while preserving its exact tree', async () => {
    const { world, parent, provisioned } = await fixture('rebased-work');
    const checkout = world.handle.repos![0]!;
    fs.writeFileSync(path.join(checkout.root, 'feature.txt'), 'feature before rebase\n');
    await gitOrThrow(checkout.root, ['add', '-A']);
    await gitOrThrow(checkout.root, ['commit', '-q', '-m', 'feature']);
    const feature = (await gitOrThrow(checkout.root, ['rev-parse', 'HEAD'])).trim();
    await gitOrThrow(checkout.root, ['reset', '--hard', '-q', parent]);
    await gitOrThrow(checkout.root, ['cherry-pick', feature]);
    const tree = (await gitOrThrow(checkout.root, ['rev-parse', 'HEAD^{tree}'])).trim();

    const result = await ensureTaskBranchAncestry(world, 'karmax/parent');
    expect(result.errors).toEqual({});
    expect(result.repaired).toHaveLength(1);
    expect((await gitOrThrow(checkout.root, ['rev-parse', 'HEAD^{tree}'])).trim()).toBe(tree);
    expect((await git(checkout.root, ['merge-base', '--is-ancestor', provisioned, 'HEAD'])).code).toBe(0);
  });

  it('refuses a target-descended candidate that merged a new unrelated root', async () => {
    const { world, parent } = await fixture('foreign-root');
    const checkout = world.handle.repos![0]!;
    await gitOrThrow(checkout.root, ['reset', '--hard', '-q', parent]);
    await gitOrThrow(checkout.root, ['checkout', '--orphan', 'foreign-history']);
    await gitOrThrow(checkout.root, ['rm', '-rf', '.']);
    fs.writeFileSync(path.join(checkout.root, 'foreign.txt'), 'foreign history\n');
    await gitOrThrow(checkout.root, ['add', '-A']);
    await gitOrThrow(checkout.root, ['commit', '-q', '-m', 'foreign root']);
    const foreign = (await gitOrThrow(checkout.root, ['rev-parse', 'HEAD'])).trim();
    await gitOrThrow(checkout.root, ['checkout', '-q', checkout.branch]);
    await gitOrThrow(checkout.root, ['reset', '--hard', '-q', parent]);
    await gitOrThrow(checkout.root, ['merge', '-q', '--allow-unrelated-histories', '--no-edit', foreign]);

    const result = await ensureTaskBranchAncestry(world, 'karmax/parent');
    expect(result.repaired).toEqual([]);
    expect(result.errors.repo).toMatch(/local recorded-base ancestry violation.*contains history unrelated to the selected target/i);
  });

  it('refuses an unrelated/rebased candidate that descends from neither recorded base nor target', async () => {
    const { world } = await fixture('unsafe-rebase');
    const checkout = world.handle.repos![0]!;
    await gitOrThrow(checkout.root, ['checkout', '--orphan', 'unrelated']);
    await gitOrThrow(checkout.root, ['rm', '-rf', '.']);
    fs.writeFileSync(path.join(checkout.root, 'foreign.txt'), 'not the task proposal\n');
    await gitOrThrow(checkout.root, ['add', '-A']);
    await gitOrThrow(checkout.root, ['commit', '-q', '-m', 'unrelated root']);
    await gitOrThrow(checkout.root, ['branch', '-f', checkout.branch, 'HEAD']);

    const result = await ensureTaskBranchAncestry(world, 'karmax/parent');
    expect(result.repaired).toEqual([]);
    expect(result.errors.repo).toMatch(/local recorded-base ancestry violation.*does not descend from selected target/i);
  });
});
