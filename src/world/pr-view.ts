import path from 'node:path';
import { taskBranch } from '../domain/brand.js';
import { type World, type WorldHandle, type WorldRepo, worldRepoTarget } from './types.js';

/**
 * One pull request of a task with several branches (SPEC §11.1), seen as a
 * world. A task's agent works in its one world, one checkout per branch; when
 * it opens a branch's pull request on its own, that pull request is a sub-task
 * which reviews and lands a snapshot of the branch from a worktree in the SAME
 * world: `<root>/.karmax-injection/pull-requests/<sub-task>`, on the sub-task's
 * branch. No second sandbox and no second agent: changes Review asks for are
 * the task's agent's, made in its own checkout, and moved here when it opens
 * the pull request again.
 *
 * The view's handle is the task's world handle (its id is the task's, so its
 * lease, credentials and records stay the task's) with `repos` narrowed to the
 * pull request's worktree. `openWorld` returns the world through the view, so
 * every activity — Review packet, PR, merge, landing — sees that one checkout.
 */
export interface PullRequestViewMeta {
  /** The sub-task owning the pull request. */
  pullRequest: string;
}

export function pullRequestRoot(handle: WorldHandle, childTaskId: string): string {
  return path.posix.join(handle.root, '.karmax-injection', 'pull-requests', childTaskId);
}

/** The view handle of `childTaskId`'s pull request of `checkout`. */
export function pullRequestHandle(handle: WorldHandle, checkout: WorldRepo, childTaskId: string, liveTarget: string): WorldHandle {
  const root = pullRequestRoot(handle, childTaskId);
  const target = worldRepoTarget(checkout, liveTarget);
  const repo: WorldRepo = { ...checkout, root, branch: taskBranch(childTaskId), base: target, target, targetPinned: true };
  delete repo.branchAdjustment;
  return { ...handle, branch: repo.branch, base: target, target, workdir: root, repos: [repo], meta: { ...handle.meta, pullRequest: childTaskId } };
}

export function isPullRequestView(handle: Pick<WorldHandle, 'meta'> | undefined): boolean {
  return typeof handle?.meta?.pullRequest === 'string';
}

/** `world` seen through a pull request's view: its handle is the view's, and
 * nothing else changes. The world object itself is shared and left untouched. */
export function pullRequestView(world: World, view: WorldHandle): World {
  let handle: WorldHandle = { ...world.handle, branch: view.branch, base: view.base, target: view.target, workdir: view.workdir,
    repos: view.repos, meta: { ...world.handle.meta, pullRequest: view.meta?.pullRequest } };
  return new Proxy(world, {
    get(target, property, receiver) {
      if (property === 'handle') return handle;
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, property, value) {
      if (property === 'handle') { handle = value as WorldHandle; return true; }
      return Reflect.set(target, property, value);
    },
  });
}
