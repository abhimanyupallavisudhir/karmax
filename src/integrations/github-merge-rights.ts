import type { GitHubAppService } from './github-app.js';

type MergeRightsSource = Pick<GitHubAppService, 'activeUserAccountId' | 'repositoryPermission'>;

/** Whether a person's connected GitHub account can merge into every one of
 * `slugs`. Advisory: GitHub is re-asked immediately before a real merge. */
export async function canMergeAll(github: MergeRightsSource, userId: string, slugs: string[], accountId?: string): Promise<boolean> {
  const account = accountId ?? (await github.activeUserAccountId(userId));
  if (!account || !slugs.length) return false;
  const permissions = await Promise.all(slugs.map((slug) => github.repositoryPermission(userId, slug, account).catch(() => undefined)));
  return permissions.every((permission) => permission?.canMerge);
}

/** The people, in order, who can merge into every one of `slugs`: whom a
 * merge nobody else can authorize asks. */
export async function mergeCapableUsers(github: MergeRightsSource, userIds: string[], slugs: string[]): Promise<string[]> {
  const capable: string[] = [];
  for (const userId of userIds) if (await canMergeAll(github, userId, slugs)) capable.push(userId);
  return capable;
}
