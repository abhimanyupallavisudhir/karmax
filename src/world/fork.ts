import type { TaskRecord, WorldCheckpoint } from '../domain/types.js';
import type { WorldHandle } from './types.js';
import { worldRepos, worldRepoSource } from './types.js';
import { sameRepository } from './repository-identity.js';

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

type CheckpointRepo = WorldCheckpoint['repos'][number];

function recordedRepo(checkpoint: WorldCheckpoint, source: string): CheckpointRepo | undefined {
  return checkpoint.repos.find((repo) => repo.role !== 'project-wiki'
    && ((repo.source && sameRepository(repo.source, source)) || (repo.localPath && sameRepository(repo.localPath, source))));
}

/** The development repositories a fork of unpublished work provisions. Its
 * checkpoint's commits and files belong to the checkouts it recorded, so those
 * come first-class even after the project's repository list changed (WD-11);
 * requested repositories the source never had follow at their normal base. The
 * companion wiki is provisioned separately and never counted twice. */
export function forkDevelopmentSources(requested: string[], checkpoint: WorldCheckpoint | undefined,
  companions: Array<string | undefined> = []): string[] {
  if (!checkpoint) return requested;
  const sources = [...requested];
  for (const repo of checkpoint.repos) {
    const source = repo.localPath ?? repo.source;
    if (!source || repo.role === 'project-wiki'
      || companions.some((companion) => companion && sameRepository(companion, source))
      || sources.some((candidate) => recordedRepo(checkpoint, candidate) === repo)) continue;
    sources.push(source);
  }
  return sources;
}

/** Which repository owns each fork checkout's base history: the authority its
 * checkpoint recorded, since the fork's base is the source's own task branch
 * and lives only there. Undefined for a repository the source never had. */
export function forkRecordedAuthority(checkpoint: WorldCheckpoint | undefined, sources: string[]): Array<'project' | 'origin' | undefined> {
  return sources.map((source) => {
    const repo = checkpoint && recordedRepo(checkpoint, source);
    return repo ? repo.sourceAuthority ?? 'project' : undefined;
  });
}
