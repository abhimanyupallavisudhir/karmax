import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';
import { WorktreeProvider } from '../src/world/worktree.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { makeCoreActivities } from '../src/activities/core.js';
import { worldRepos, type WorldHandle } from '../src/world/types.js';
import { pullRequestHandle } from '../src/world/pr-view.js';
import { gitOrThrow, ensureIdentity } from '../src/world/git.js';

/**
 * pramana#137: a task with several branches of one repository was restored
 * from its checkpoint, which makes every checkout its own clone. Its pull
 * request for "deploy-disk" then lived in another checkout's repository, and
 * moving it to deploy-disk's new head failed with "Could not parse object",
 * which failed the pull request's whole run. Real git, no Temporal.
 */
describe('a pull request after its task\'s world was restored', () => {
  let home: string;
  let scratch: string;
  let store: Store;

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-prmove-'));
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-prmove-repos-'));
    store = await Store.create(':memory:');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await store.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const commitIn = async (root: string, file: string) => {
    fs.writeFileSync(path.join(root, file), `${file}\n`);
    await gitOrThrow(root, ['add', '-A']);
    await gitOrThrow(root, ['commit', '-q', '-m', file]);
    return gitOrThrow(root, ['rev-parse', 'HEAD']);
  };

  /** A task world with checkouts "app" and "docs" of one repository, "docs"
   * then made its own clone, as a checkpoint restore leaves it. */
  async function restoredWorld() {
    const repo = path.join(scratch, 'app');
    fs.mkdirSync(repo);
    await gitOrThrow(repo, ['init', '-q', '-b', 'main']);
    await ensureIdentity(repo);
    await commitIn(repo, 'a.js');
    const provider = new WorktreeProvider(home);
    const world = await provider.create({ taskId: 't-pr', repo, base: 'main', target: 'main', layout: 'nested' });
    await world.addCheckout!({ name: 'docs' });
    const [main, docs] = worldRepos(world.handle);
    const shipped = await commitIn(docs!.root, 'guide.md');
    const view = pullRequestHandle(world.handle, docs!, 'task_child', 'main');
    const pr = view.repos![0]!;
    // The pull request's worktree belongs to the first checkout's repository.
    await gitOrThrow(main!.root, ['worktree', 'add', '-q', '-B', pr.branch, pr.root, shipped]);
    // "docs" becomes its own clone, on its branch at the shipped commit.
    await gitOrThrow(main!.root, ['worktree', 'remove', '--force', docs!.root]);
    await gitOrThrow(scratch, ['clone', '-q', main!.root, docs!.root]);
    await ensureIdentity(docs!.root);
    await gitOrThrow(docs!.root, ['checkout', '-q', '-B', docs!.branch, shipped]);
    const worlds = new WorldRegistry();
    worlds.register(provider);
    vi.spyOn(store, 'currentWorld').mockResolvedValue(world.handle as any);
    const core = makeCoreActivities({ store, worlds, contentDir: home, profiles: new ProfileResolver(store, 'mock'), adapters: new Map() as any });
    return { world, view, pr, docs: docs!, main: main!, core };
  }

  it('moves to a commit only its checkout\'s own clone has', async () => {
    const { view, pr, docs, core } = await restoredWorld();
    const head = await commitIn(docs.root, 'more.md');
    await expect(gitOrThrow(pr.root, ['cat-file', '-e', `${head}^{commit}`])).rejects.toThrow();

    await core.movePullRequest(view as WorldHandle, head);

    expect(await gitOrThrow(pr.root, ['rev-parse', 'HEAD'])).toBe(head);
    expect(fs.existsSync(path.join(pr.root, 'more.md'))).toBe(true);
  });

  it('rebuilds a lost worktree from its own checkout when that has its branch', async () => {
    const { view, pr, docs, main, core } = await restoredWorld();
    // The restore lost the worktree; the branch is in "docs"' clone too.
    await gitOrThrow(main.root, ['worktree', 'remove', '--force', pr.root]);
    await gitOrThrow(docs.root, ['branch', '-f', pr.branch, 'HEAD']);
    const head = await commitIn(docs.root, 'later.md');

    await core.movePullRequest(view as WorldHandle, head);

    expect(await gitOrThrow(pr.root, ['rev-parse', 'HEAD'])).toBe(head);
    // It is a worktree of "docs"' repository now, which has every commit of "docs".
    expect(await gitOrThrow(docs.root, ['worktree', 'list'])).toContain(pr.root);
  });
});
