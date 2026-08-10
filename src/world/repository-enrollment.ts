import { brokerEnrollRepository, type GitBrokerAuth } from './git-broker.js';
import { sameRepository } from './repository-identity.js';
import { worldRepos, worldRepoSource, type World, type WorldRepo } from './types.js';

export interface EnrolledProjectRepository {
  baseBranch?: string;
  targetBranch?: string;
  repository: { name: string; sshUrl: string; defaultBranch: string };
}

/** Reconcile one live world with the project's current repository attachments.
 * The broker owns clone/bootstrap security; this helper owns the common branch
 * policy and identity projection used by both workflow activities and the
 * agent-facing collaboration API. */
export async function enrollWorldRepositories(
  world: World,
  attachments: EnrolledProjectRepository[],
  auth: GitBrokerAuth,
  onEnrolled?: (repo: WorldRepo) => Promise<void> | void,
): Promise<WorldRepo[]> {
  const added: WorldRepo[] = [];
  for (const attachment of attachments) {
    if (worldRepos(world.handle).some((repo) => sameRepository(worldRepoSource(repo), attachment.repository.sshUrl))) continue;
    const base = attachment.baseBranch ?? attachment.repository.defaultBranch ?? world.handle.base;
    const target = attachment.targetBranch ?? base;
    const existing = worldRepos(world.handle)[0];
    const [nameResult, emailResult] = existing
      ? await Promise.all([
          world.exec('git', ['config', '--get', 'user.name'], { cwd: existing.root }).catch(() => undefined),
          world.exec('git', ['config', '--get', 'user.email'], { cwd: existing.root }).catch(() => undefined),
        ])
      : [undefined, undefined];
    const enrolled = await brokerEnrollRepository(world, {
      source: attachment.repository.sshUrl,
      name: attachment.repository.name,
      branch: world.handle.branch,
      base,
      target,
      targetPinned: Boolean(attachment.targetBranch),
      identity: {
        name: nameResult?.code === 0 && nameResult.stdout.trim() ? nameResult.stdout.trim() : 'karmax',
        email: emailResult?.code === 0 && emailResult.stdout.trim() ? emailResult.stdout.trim() : 'karmax@localhost',
      },
    }, auth);
    await onEnrolled?.(enrolled);
    added.push(enrolled);
  }
  return added;
}
