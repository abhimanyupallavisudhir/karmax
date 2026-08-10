import type { Project } from '../domain/types.js';
import type { Store } from '../store/db.js';
import { defaultBranch } from '../world/git.js';
import { sameRepository } from '../world/repository-identity.js';
import { expandPath } from '../util/expand.js';

export interface RepositoryBranchDefaults {
  base: string;
  target: string;
}

/** New task records carry this after their common base/target have already been
 * resolved against repository metadata. Its absence identifies older queued
 * tasks that still need provisioning's legacy repository-default fallback. */
export const REPOSITORY_BRANCHES_RESOLVED_PARAM = '_repositoryBranchesResolved';

/**
 * Resolve the branch policy for a project's effective first repository.
 *
 * Hosted projects configure an SSH URL, which cannot be passed to `git` as a
 * working directory. Their enrolled repository record is therefore the source
 * of truth. Local/path-only projects retain the existing origin/HEAD probe.
 */
export async function repositoryBranchDefaults(
  store: Pick<Store, 'listProjectRepositories'>,
  project: Project,
  source: string | undefined,
): Promise<RepositoryBranchDefaults | undefined> {
  if (!source) return undefined;
  const linked = store.listProjectRepositories(project.id)
    .find((candidate) => sameRepository(candidate.repository.sshUrl, source));
  if (linked) {
    const base = linked.baseBranch ?? linked.repository.defaultBranch;
    return { base, target: linked.targetBranch ?? base };
  }

  const branch = await defaultBranch(expandPath(source)).catch(() => undefined);
  return branch ? { base: branch, target: branch } : undefined;
}
