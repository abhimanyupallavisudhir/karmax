import { CredentialBroker } from '../autonomy/broker.js';
import { GitProfiles, userGitScope } from '../autonomy/git-profiles.js';
import type { GitProfile } from '../domain/types.js';
import { Store } from '../store/db.js';
import type { GitHubUserIdentity } from './github-app.js';

/**
 * Give a user's empty Personal organization a live reference to their default
 * Git identity. This is deliberately an inheritance link, not a copy: account
 * changes and revocation remain owned by the user. An explicit organization
 * GitHub installation or an existing organization profile always wins.
 */
export function inheritPersonalGithubProfile(store: Store, broker: CredentialBroker,
  userId: string): boolean {
  const userProfiles = new GitProfiles(store, broker, undefined, userGitScope(userId));
  if (!userProfiles.resolve(undefined)) return false;
  const personal = store.listOrganizations(userId).find((organization) => organization.kind === 'personal');
  if (!personal || store.listGitConnections(personal.id).length) return false;
  const organizationProfiles = new GitProfiles(store, broker, undefined, personal.id);
  if (organizationProfiles.list().length || organizationProfiles.defaultProfile()) return false;
  organizationProfiles.reuseUserProfile(userProfiles);
  return true;
}

/** Persist a connected GitHub identity and apply the Personal-org default. */
export function saveGithubUserIdentity(store: Store, broker: CredentialBroker, userId: string,
  identity: GitHubUserIdentity): GitProfile {
  const profile = new GitProfiles(store, broker, undefined, userGitScope(userId))
    .saveGithubIdentity(identity);
  inheritPersonalGithubProfile(store, broker, userId);
  return profile;
}
