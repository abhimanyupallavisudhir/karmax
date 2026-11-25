/**
 * The organization wiki in Git (wiki features/organization-wiki): its canonical
 * checkout is a Git repository like a project wiki's, every edit a commit by
 * the person or agent who made it, published — where this installation hosts
 * repositories — to a repository tavya keeps for the organization, hidden from
 * the repositories people attach. Who reads and writes it does not change: it
 * is edited through the wiki API with the organization's authority, and read
 * by every task of the organization.
 *
 * The database keeps its journal of every edit (organization_wiki_versions):
 * backups and data exports carry the wiki whatever happens to this host.
 */
import type { Repository } from '../domain/types.js';
import type { Store } from '../store/db.js';
import type { GitCredential } from '../world/git-credential.js';
import { hostedGit, repositoryBrokerCredentials } from '../world/hosted-git.js';
import { ensureOrganizationWikiRepository, setProjectWikiRemote } from './repository.js';

/** The name its repository is made with. */
export const organizationWikiRepositoryName = (organizationId: string): string => `organization-wiki-${organizationId.slice(-8)}`;

/** Where the organization's wiki publishes, made if this installation hosts
 * repositories and it has none yet; undefined when there is nowhere. */
export async function organizationWikiRemote(store: Store, organizationId: string): Promise<Repository | undefined> {
  const current = await store.organizationWikiRepository(organizationId);
  if (current) return current;
  const hosted = hostedGit();
  if (!hosted) return undefined;
  const repository = await store.linkHostedOrganizationWiki(organizationId, organizationWikiRepositoryName(organizationId));
  await hosted.create(repository, { empty: true });
  return repository;
}

/** The credential one publish uses (tavya's own grant), or undefined when the wiki stays local. */
export async function organizationWikiPublishTarget(store: Store, organizationId: string): Promise<{ remote: string; credential: GitCredential } | undefined> {
  const repository = await store.organizationWikiRepository(organizationId);
  if (!repository) return undefined;
  return { remote: repository.sshUrl, credential: await repositoryBrokerCredentials(repository, undefined) };
}

/** The organization wiki as a Git repository, published if it can be.
 * Idempotent: a later call only reconciles with its remote. */
export async function ensureOrganizationWiki(store: Store, contentDir: string, organizationId: string): Promise<string> {
  const root = await ensureOrganizationWikiRepository(contentDir, organizationId);
  const repository = await organizationWikiRemote(store, organizationId);
  if (repository) await setProjectWikiRemote(root, repository.sshUrl, await repositoryBrokerCredentials(repository, undefined));
  return root;
}

/** Boot: every organization's wiki in Git. One that fails is logged and tried
 * again at its next edit or the next boot. */
export async function ensureEveryOrganizationWiki(store: Store, contentDir: string, log: (message: string) => void = console.warn): Promise<void> {
  for (const organization of await store.listOrganizations()) {
    await ensureOrganizationWiki(store, contentDir, organization.id).catch((error) =>
      log(`  • Could not put the wiki of ${organization.id} in Git: ${error instanceof Error ? error.message : String(error)}`));
  }
}
