import type { TaskRecord } from '../domain/types.js';
import type { WorldHandle } from './types.js';
import { worldRepos, worldRepoSource } from './types.js';

/** A branch choice and the optional unpublished state belonging to that choice.
 * Kept on the new task so landing the source later cannot change its meaning. */
export interface ForkWorldSource {
  taskId: string;
  base: string;
  unpublished: boolean;
  repos: Array<{ source: string; name: string; base: string; target: string }>;
}

/** The branch the task lands on (empty when unknown ⇒ the project default). */
export function forkLandingBranch(task: TaskRecord, handle?: WorldHandle): string {
  return task.lastView?.targetBranch ?? handle?.target ?? String(task.params.target ?? '');
}

export function forkWorldSource(task: TaskRecord, handle?: WorldHandle): ForkWorldSource | undefined {
  const view = task.lastView;
  const landed = view?.status === 'done';
  const target = forkLandingBranch(task, handle);
  const base = landed ? target : handle?.branch ?? view?.branch;
  if (!base) return undefined;
  return { taskId: task.id, base, unpublished: !landed,
    repos: handle ? worldRepos(handle).map((repo) => ({ source: worldRepoSource(repo), name: repo.name,
      base: landed ? repo.target ?? target : repo.branch,
      target: repo.target || target || repo.base })) : [] };
}
