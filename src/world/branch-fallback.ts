import type { BranchAdjustment } from '../domain/types.js';
import { validGitBranch } from '../util/git-ref.js';

/** Record the actual named branch, never leave an unresolved name attached to
 * a checkout that was created from some other commit. Distinct targets retain
 * their independent meaning. */
export function missingBaseAdjustment(repo: string, requestedBase: string, requestedTarget: string | undefined,
  base: string): BranchAdjustment {
  if (!validGitBranch(base) || base === 'HEAD')
    throw new Error(`Repository "${repo}" has no named fallback branch for missing base "${requestedBase}"`);
  const followsBase = !requestedTarget || requestedTarget === requestedBase;
  const target = followsBase ? base : requestedTarget;
  const warning = `repo "${repo}": ${followsBase ? 'Base and target branch' : 'Base branch'} changed to "${base}" because "${requestedBase}" did not exist`
    + (followsBase ? '.' : `; target remains "${target}".`);
  return { requestedBase, requestedTarget, base, target, warning };
}
