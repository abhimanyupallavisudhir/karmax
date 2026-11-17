/**
 * Where a project's wiki is published (SPEC §4.4): on the host its code is on.
 * A cloud world clones the wiki from there and lands its edits back through
 * it, so a project whose repositories tavya hosts (wiki
 * features/hosted-repositories) gets its wiki on tavya, and any other a private
 * GitHub repository made through the organization's GitHub connection.
 *
 * The gateway calls this when a project is made, changed or used; a cloud
 * world's set-up calls it too, and waits for it, so a task never depends on a
 * background attempt having finished first (tavya-error 1d0724aaf3e40071).
 */
import type { Project, Repository } from '../domain/types.js';
import type { Store } from '../store/db.js';
import type { GitHubAppService } from '../integrations/github-app.js';
import { BRAND } from '../domain/brand.js';
import { isHostedRepository } from '../domain/hosted-repository.js';
import { git } from '../world/git.js';
import { hostedGit, repositoryBrokerCredentials } from '../world/hosted-git.js';
import { sameRepository } from '../world/repository-identity.js';
import { setProjectWikiRemote } from './repository.js';

export interface ProjectWikiRemoteDeps {
  store: Store;
  githubApp?: Pick<GitHubAppService, 'brokerCredentials' | 'repositoryCreator' | 'ensureRepository'>;
  /** The installation's name, for a GitHub repository's description. */
  siteName?: string;
}

/** The linked repository, or why there is none. */
export interface ProjectWikiRemote { repository?: Repository; reason?: string }

/** The name a project's wiki repository is first made with; it keeps it across renames. */
export function projectWikiRepositoryName(project: Pick<Project, 'id' | 'name'>): string {
  const base = project.name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'project';
  return `${base}-wiki-${project.id.slice(-8)}`;
}

/** Whether the canonical wiki at `root` already publishes to `repository`:
 * then a cloud world can clone it from there. */
export async function projectWikiRemoteReady(root: string, repository: Repository | undefined): Promise<boolean> {
  if (!repository || !(isHostedRepository(repository) || repository.private)) return false;
  const origin = await git(root, ['remote', 'get-url', 'origin']);
  return origin.code === 0 && sameRepository(origin.stdout.trim(), repository.sshUrl);
}

/**
 * Link the project's wiki to a repository on its code's host, made if need be,
 * and publish the canonical wiki at `root` there. Idempotent; concurrent calls
 * link one repository. Throws when a host refuses; returns a `reason` when
 * there is nowhere to publish yet (no host this installation can use).
 */
export async function ensureProjectWikiRemote(deps: ProjectWikiRemoteDeps, project: Project, root: string,
  options: { userId?: string } = {}): Promise<ProjectWikiRemote> {
  const { store, githubApp } = deps;
  const current = (await store.projectWiki(project.id))?.repository;
  if (current && (isHostedRepository(current) || (current.private && current.gitConnectionId && githubApp)))
    return publish(deps, root, current);
  const linked = (await store.listProjectRepositories(project.id)).map((entry) => entry.repository);
  if (!current && linked.length && linked.every(isHostedRepository)) {
    const hosted = hostedGit();
    if (!hosted) return { reason: 'this installation does not host repositories, so the wiki of a project on tavya has nowhere to live' };
    const repository = await store.linkHostedProjectWiki(project.id, projectWikiRepositoryName(project));
    if (isHostedRepository(repository)) await hosted.create(repository, { empty: true });
    return publish(deps, root, repository);
  }
  return ensureGithubWiki(deps, project, root, current, linked, options.userId);
}

async function publish(deps: ProjectWikiRemoteDeps, root: string, repository: Repository): Promise<ProjectWikiRemote> {
  await setProjectWikiRemote(root, repository.sshUrl, await repositoryBrokerCredentials(repository, deps.githubApp));
  return { repository };
}

/** A private GitHub repository in the account the project's code is in. */
async function ensureGithubWiki(deps: ProjectWikiRemoteDeps, project: Project, root: string,
  current: Repository | undefined, linked: Repository[], userId: string | undefined): Promise<ProjectWikiRemote> {
  const { store, githubApp } = deps;
  if (!githubApp) return { repository: current, reason: 'GitHub is not connected' };
  const organizationId = project.organizationId ?? 'org_personal';
  const connections = await store.listGitConnections(organizationId);
  const attachedConnectionIds = [...new Set(linked.map((repository) => repository.gitConnectionId).filter((id): id is string => Boolean(id)))];
  const connection = current?.gitConnectionId
    ? connections.find((candidate) => candidate.id === current.gitConnectionId)
    : attachedConnectionIds.length === 1
      ? connections.find((candidate) => candidate.id === attachedConnectionIds[0])
      : connections.length === 1 ? connections[0] : undefined;
  if (!connection) return { repository: current, reason: connections.length
    ? 'the project\'s repositories are in several GitHub accounts, so it is not clear which should hold its wiki'
    : 'no GitHub account is connected to this organization' };
  // Who it is made as: an organization's installation (with a person's
  // authorization as fallback), or a personal account's own owner.
  const candidates = [...new Set([
    ...(userId ? [userId] : []),
    ...(await store.listOrganizationMemberships(organizationId))
      .sort((a, b) => Number(b.role === 'owner') - Number(a.role === 'owner'))
      .map((membership) => membership.userId),
  ])];
  const creator = await githubApp.repositoryCreator(connection, candidates).catch(() => undefined);
  if (!creator) return { repository: current,
    reason: `only ${connection.accountLogin} can create the wiki's repository in their personal GitHub account; they need to connect their own GitHub account here` };
  const repository = await githubApp.ensureRepository(connection.id, creator.userId, {
    // A rename keeps the remote it was first made with.
    name: current?.name ?? projectWikiRepositoryName(project),
    description: `${deps.siteName ?? BRAND} project wiki for ${project.name}`,
    private: true, defaultBranch: 'main', autoInit: false,
  });
  // Link before the push, so even a failed push keeps this platform-owned
  // repository out of the project's repository picker.
  await store.setProjectWikiRepository(project.id, repository.id);
  return publish(deps, root, repository);
}

/**
 * A project whose code has moved from tavya to GitHub (Move to GitHub) takes
 * its wiki along, so the project stays on one host: the canonical wiki first
 * takes in tavya's copy, is published to a private GitHub repository in
 * `connectionId`'s account, which becomes its wiki, and tavya's copy is
 * deleted. Nothing to do while any of the project's code is still on tavya.
 * Callers make sure no unfinished task's world still knows the old address.
 */
export async function moveProjectWikiToGithub(deps: ProjectWikiRemoteDeps, project: Project, root: string,
  connectionId: string, userId: string | undefined): Promise<Repository | undefined> {
  const { store, githubApp } = deps;
  const current = (await store.projectWiki(project.id))?.repository;
  if (!current || !isHostedRepository(current) || !githubApp) return undefined;
  const linked = (await store.listProjectRepositories(project.id)).map((entry) => entry.repository);
  if (!linked.length || linked.some(isHostedRepository)) return undefined;
  await publish(deps, root, current);
  const repository = await githubApp.ensureRepository(connectionId, userId, {
    name: current.name, description: `${deps.siteName ?? BRAND} project wiki for ${project.name}`,
    private: true, defaultBranch: 'main', autoInit: false,
  });
  await store.setProjectWikiRepository(project.id, repository.id);
  await publish(deps, root, repository);
  await hostedGit()?.remove(current);
  await store.deleteRepository(current.id);
  return repository;
}
