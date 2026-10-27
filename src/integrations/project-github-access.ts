import type { Project, Repository } from '../domain/types.js';
import type { Store } from '../store/db.js';
import type { AuthorizationService } from '../platform/authorization.js';
import type { Capability } from '../platform/capabilities.js';
import { allows } from '../platform/capabilities.js';
import { GITHUB_REPOSITORY_ROLES, type GitHubAppService, type GitHubRepositoryInvitation, type GitHubRepositoryRole } from './github-app.js';

/**
 * GitHub access to a project's repositories follows access in tavya.
 *
 * Pull requests are opened as the task's creator, and GitHub answers a person
 * who cannot see a private repository with 404. tavya creates each project's
 * wiki repository in the account of whoever installed its GitHub App, and a
 * project's code repositories belong to whoever connected them, so a member
 * nobody had invited by hand could not open their task's pull request
 * (andhbhakt.com #8, video-explainers #4). People who are not developers should
 * never have to find and accept a GitHub invitation either.
 *
 * So every GitHub-connected repository a project uses has as collaborators,
 * through every GitHub account they linked, whoever has access to the project:
 * - as a code repository: push for whoever may run tasks there (`task:create`),
 *   pull for whoever may only read the project (`project:read`);
 * - as the project's wiki: push for whoever may edit the wiki (`skill:write`),
 *   pull for whoever may only read it.
 * A repository several projects use gets the strongest role over all of them,
 * so leaving one project keeps what another still gives. A personal account's
 * repository has only one collaborator role, write (GitHub refuses read:
 * `Cannot assign … permission of read`), so there read-only members get
 * nothing: tavya never gives more on GitHub than in tavya. The invitation is
 * accepted as them at once.
 *
 * Only access tavya gave is ever taken back: the owner and people added by hand
 * keep theirs, and a role tavya raised returns to what it was. What tavya gave
 * is recorded per repository (`wiki-github-access:<repositoryId>`, the key the
 * wiki-only version used, so its grants are still found), and the repositories
 * it gave access to for a project are remembered (`project-github-access:<projectId>`),
 * so detaching one still takes back what only that project gave.
 */

type GithubAccessApp = Pick<GitHubAppService, 'listUserAccounts' | 'repositoryCollaborators' | 'repositoryInvitations'
  | 'addRepositoryCollaborator' | 'acceptRepositoryInvitation' | 'removeRepositoryCollaborator'>;

export interface RepositoryAccessGrant {
  userId: string;
  accountId: string;
  login: string;
  role: GitHubRepositoryRole;
  /** The role the person had before tavya raised it; restored, not removed, when access ends. */
  previousRole?: GitHubRepositoryRole;
}

export interface RepositoryAccessOutcome {
  userId: string;
  login: string;
  /** `invited`: GitHub holds an invitation tavya could not accept for them. */
  state: 'member' | 'invited' | 'owner' | 'failed';
  detail?: string;
}

/** How a project uses a repository: as one of its code repositories, or as its wiki. */
export type RepositoryUse = 'code' | 'wiki';

const grantsKey = (repositoryId: string) => `wiki-github-access:${repositoryId}`;
const projectKey = (projectId: string) => `project-github-access:${projectId}`;
const rank = (role: GitHubRepositoryRole) => GITHUB_REPOSITORY_ROLES.indexOf(role);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

/** The role on GitHub matching what someone with `caps` may do with the project. */
function roleForUse(caps: Capability[], use: RepositoryUse): GitHubRepositoryRole | undefined {
  if (allows(caps, use === 'code' ? 'task:create' : 'skill:write')) return 'push';
  return allows(caps, 'project:read') ? 'pull' : undefined;
}

export class ProjectGithubAccess {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private lanes = new Map<string, Promise<unknown>>();
  private stops: Array<() => unknown> = [];
  private stopped = false;

  constructor(private deps: {
    store: Store;
    githubApp: GithubAccessApp;
    authorization?: AuthorizationService;
    /** Coalesces a burst of changes (a member added with a role) into one sync. */
    debounceMs?: number;
    log?: (line: string) => void;
  }) {}

  /** The role on GitHub that matches what the person may do with the project's
   * wiki (`use` 'wiki', the default) or code repositories (`use` 'code') in tavya. */
  async roleFor(userId: string, project: Project, use: RepositoryUse = 'wiki'): Promise<GitHubRepositoryRole | undefined> {
    if (!this.deps.authorization)
      return (await this.deps.store.organizationMembership(project.organizationId ?? 'org_personal', userId)) ? 'push' : undefined;
    return roleForUse(await this.deps.authorization.capabilitiesAsync(`user:${userId}`, project.id, project.organizationId), use);
  }

  /** The strongest role over every way a project uses the repository. */
  private async roleAcross(userId: string, uses: Array<{ project: Project; use: RepositoryUse }>): Promise<GitHubRepositoryRole | undefined> {
    let best: GitHubRepositoryRole | undefined;
    const caps = new Map<string, Promise<Capability[]>>();
    for (const { project, use } of uses) {
      let role: GitHubRepositoryRole | undefined;
      if (this.deps.authorization) {
        const authorization = this.deps.authorization;
        if (!caps.has(project.id)) caps.set(project.id, authorization.capabilitiesAsync(`user:${userId}`, project.id, project.organizationId));
        role = roleForUse(await caps.get(project.id)!, use);
      } else role = await this.roleFor(userId, project, use);
      if (role && (!best || rank(role) > rank(best))) best = role;
    }
    return best;
  }

  /** The projects that use a repository, and how. */
  private async uses(repositoryId: string): Promise<Array<{ project: Project; use: RepositoryUse }>> {
    const { store } = this.deps;
    const found: Array<{ project: Project; use: RepositoryUse }> = [];
    for (const [use, projectIds] of [['code', await store.projectIdsForRepository(repositoryId)],
      ['wiki', await store.projectIdsForWikiRepository(repositoryId)]] as const) {
      for (const projectId of projectIds) {
        const project = await store.getProject(projectId);
        if (project) found.push({ project, use });
      }
    }
    return found;
  }

  /** The GitHub-connected repositories a project uses now: its code repositories and its wiki. */
  async projectRepositoryIds(projectId: string): Promise<string[]> {
    const { store } = this.deps;
    const repositories = [...(await store.listProjectRepositories(projectId)).map((entry) => entry.repository),
      ...[(await store.projectWiki(projectId))?.repository].filter((repository): repository is Repository => !!repository)];
    return [...new Set(repositories.filter((repository) => repository.gitConnectionId).map((repository) => repository.id))];
  }

  /**
   * Bring the collaborators of every repository the project uses, and of every
   * one it stopped using that tavya gave access to for it, in line with tavya.
   * With `onlyUserId`, only that person is granted access (nobody loses any).
   */
  async syncProject(projectId: string, onlyUserId?: string): Promise<RepositoryAccessOutcome[]> {
    return this.syncProjectRepositories(projectId, onlyUserId);
  }

  /** `done`: repositories already synced in this pass (an organization or the
   * boot sweep visits a shared repository once). */
  private async syncProjectRepositories(projectId: string, onlyUserId?: string, done?: Set<string>): Promise<RepositoryAccessOutcome[]> {
    const current = await this.projectRepositoryIds(projectId);
    // Remember before asking GitHub, so access given is always found again to take back.
    if (!onlyUserId && current.length) await this.track(projectId, (ids) => [...new Set([...ids, ...current])]);
    const former = onlyUserId ? [] : (await this.tracked(projectId)).filter((id) => !current.includes(id));
    const outcomes: RepositoryAccessOutcome[] = [];
    const synced = new Set<string>();
    for (const repositoryId of [...current, ...former]) {
      if (done?.has(repositoryId)) { synced.add(repositoryId); continue; }
      done?.add(repositoryId);
      try {
        outcomes.push(...(await this.syncRepository(repositoryId, onlyUserId)));
        synced.add(repositoryId);
      } catch (error) {
        this.deps.log?.(`GitHub access sync for repository ${repositoryId} of project ${projectId} failed: ${message(error)}`);
      }
    }
    // A repository the project no longer uses is forgotten once nothing tavya
    // gave on it remains, or once another project that uses it keeps it in step.
    const settled: string[] = [];
    for (const repositoryId of former) {
      if (!synced.has(repositoryId)) continue;
      if (!Object.keys(await this.grants(repositoryId)).length || (await this.uses(repositoryId)).length
        || !(await this.deps.store.getRepository(repositoryId))) settled.push(repositoryId);
    }
    if (settled.length) await this.track(projectId, (ids) => ids.filter((id) => !settled.includes(id)));
    return outcomes;
  }

  /**
   * Bring one repository's collaborators in line with tavya, over every project
   * that uses it. With `onlyUserId`, only that person is granted access (nobody
   * loses any): what a pull request opened as them needs first.
   */
  async syncRepository(repositoryId: string, onlyUserId?: string): Promise<RepositoryAccessOutcome[]> {
    return this.inLane(repositoryId, () => this.reconcile(repositoryId, onlyUserId));
  }

  private async reconcile(repositoryId: string, onlyUserId?: string): Promise<RepositoryAccessOutcome[]> {
    const { store, githubApp } = this.deps;
    const repository = await store.getRepository(repositoryId);
    if (!repository?.gitConnectionId) return [];
    const uses = await this.uses(repositoryId);
    const granted = await this.grants(repository.id);
    if (onlyUserId && !uses.length) return [];
    const userIds = onlyUserId ? [onlyUserId] : [...new Set([
      ...(await store.listOrganizationMemberships(repository.organizationId)).map((member) => member.userId),
      ...(await Promise.all([...new Set(uses.map(({ project }) => project.id))].map((projectId) => store.listProjectMemberships(projectId))))
        .flat().flatMap((member) => member.principal.kind === 'user' ? [member.principal.userId] : []),
      ...Object.values(granted).map((grant) => grant.userId),
    ])];
    const personal = (await store.getGitConnection(repository.gitConnectionId))?.accountType === 'User';
    const wanted = new Map<string, Omit<RepositoryAccessGrant, 'previousRole'>>();
    for (const userId of userIds) {
      const role = uses.length ? await this.roleAcross(userId, uses) : undefined;
      if (!role || (personal && role !== 'push')) continue;
      for (const account of await githubApp.listUserAccounts(userId).catch(() => []))
        wanted.set(account.login.toLowerCase(), { userId, accountId: account.id, login: account.login, role });
    }
    if (onlyUserId && !wanted.size) return [];
    if (!wanted.size && !Object.keys(granted).length) return [];
    const collaborators = new Map((await githubApp.repositoryCollaborators(repository))
      .map((collaborator) => [collaborator.login.toLowerCase(), collaborator.role]));
    const invitations = new Map((await githubApp.repositoryInvitations(repository))
      .map((invitation) => [invitation.login.toLowerCase(), invitation]));
    const outcomes: RepositoryAccessOutcome[] = [];
    for (const [key, want] of wanted) {
      if (key === repository.owner.toLowerCase()) {
        outcomes.push({ userId: want.userId, login: want.login, state: 'owner' });
        continue;
      }
      try {
        outcomes.push(await this.grant(repository, want, collaborators.get(key), invitations.get(key), granted[key]));
      } catch (error) {
        this.deps.log?.(`could not give ${want.login} access to ${repository.owner}/${repository.name}: ${message(error)}`);
        outcomes.push({ userId: want.userId, login: want.login, state: 'failed', detail: message(error) });
      }
    }
    if (onlyUserId) return outcomes;
    for (const [key, grant] of Object.entries(granted)) {
      if (wanted.has(key)) continue;
      try {
        await this.revoke(repository, grant, collaborators.has(key), invitations.get(key)?.id);
      } catch (error) {
        this.deps.log?.(`could not remove ${grant.login}'s access to ${repository.owner}/${repository.name}: ${message(error)}`);
      }
    }
    return outcomes;
  }

  private async grant(repository: Repository, want: Omit<RepositoryAccessGrant, 'previousRole'>,
    have: GitHubRepositoryRole | undefined, invitation: GitHubRepositoryInvitation | undefined,
    mine: RepositoryAccessGrant | undefined): Promise<RepositoryAccessOutcome> {
    const { githubApp } = this.deps;
    const member = { userId: want.userId, login: want.login };
    // Someone else's access that already covers the repository is theirs to keep;
    // tavya's own grant follows the person's role in tavya, down as well as up.
    if (have && (mine ? have === want.role : rank(have) >= rank(want.role))) {
      if (mine && (mine.accountId !== want.accountId || mine.userId !== want.userId))
        await this.record(repository.id, want.login, { ...mine, ...want });
      return { ...member, state: 'member' };
    }
    let invitationId = !have && !invitation?.expired && invitation?.role === want.role ? invitation.id : undefined;
    // Record before asking GitHub, so access tavya gave is always found again to take back.
    await this.record(repository.id, want.login, { ...want,
      ...(mine?.previousRole ? { previousRole: mine.previousRole } : have && !mine ? { previousRole: have } : {}) });
    if (invitationId === undefined) {
      const added = await githubApp.addRepositoryCollaborator(repository, want.login, want.role);
      if (!have) invitationId = added.invitationId;
    }
    if (invitationId === undefined) return { ...member, state: 'member' };
    try {
      await githubApp.acceptRepositoryInvitation(want.userId, want.accountId, invitationId);
      return { ...member, state: 'member' };
    } catch (error) {
      return { ...member, state: 'invited', detail: message(error) };
    }
  }

  private async revoke(repository: Repository, grant: RepositoryAccessGrant, collaborator: boolean, invitationId?: number): Promise<void> {
    const { githubApp } = this.deps;
    if (collaborator && grant.previousRole) await githubApp.addRepositoryCollaborator(repository, grant.login, grant.previousRole);
    else if (collaborator) await githubApp.removeRepositoryCollaborator(repository, grant.login);
    else if (invitationId !== undefined) await githubApp.removeRepositoryCollaborator(repository, grant.login, invitationId);
    await this.record(repository.id, grant.login, undefined);
  }

  /** Access tavya gave on one repository, by lower-cased login. */
  async grants(repositoryId: string): Promise<Record<string, RepositoryAccessGrant>> {
    try {
      const value = JSON.parse((await this.deps.store.kvGet(grantsKey(repositoryId))) ?? '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  }

  private async record(repositoryId: string, login: string, grant: RepositoryAccessGrant | undefined): Promise<void> {
    const { store } = this.deps;
    const key = grantsKey(repositoryId);
    // The gateway and the activity worker both grant: merge under a lock.
    await store.transaction(async () => {
      await store.lock(`kv:${key}`);
      const grants = await this.grants(repositoryId);
      if (grant) grants[login.toLowerCase()] = grant;
      else delete grants[login.toLowerCase()];
      if (Object.keys(grants).length) await store.kvSet(key, JSON.stringify(grants));
      else await store.kvDelete(key);
    });
  }

  /** The repositories tavya keeps in step for a project, including ones it stopped using. */
  async tracked(projectId: string): Promise<string[]> {
    try {
      const value = JSON.parse((await this.deps.store.kvGet(projectKey(projectId))) ?? '[]');
      return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
    } catch { return []; }
  }

  private async track(projectId: string, change: (ids: string[]) => string[]): Promise<void> {
    const { store } = this.deps;
    const key = projectKey(projectId);
    await store.transaction(async () => {
      await store.lock(`kv:${key}`);
      const before = await this.tracked(projectId);
      const after = change(before);
      if (after.length === before.length && after.every((id, index) => id === before[index])) return;
      if (after.length) await store.kvSet(key, JSON.stringify(after));
      else await store.kvDelete(key);
    });
  }

  /** One sync per repository at a time in this process; GitHub calls stay
   * ordered even when two projects share the repository. */
  private inLane<T>(repositoryId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.lanes.get(repositoryId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    const settled = next.catch(() => undefined);
    this.lanes.set(repositoryId, settled);
    void settled.then(() => { if (this.lanes.get(repositoryId) === settled) this.lanes.delete(repositoryId); });
    return next;
  }

  /** Sync after an access change in an organization or a project (`onAccessChanged`). */
  schedule(scopeKey: string): void {
    const [kind, id] = [scopeKey.slice(0, scopeKey.indexOf(':')), scopeKey.slice(scopeKey.indexOf(':') + 1)];
    if (!id || (kind !== 'organization' && kind !== 'project')) return;
    if (this.stopped) return;
    clearTimeout(this.timers.get(scopeKey));
    const timer = setTimeout(() => {
      this.timers.delete(scopeKey);
      void this.syncScope(kind, id).catch((error) => this.deps.log?.(`GitHub access sync for ${scopeKey} failed: ${message(error)}`));
    }, this.deps.debounceMs ?? 2_000);
    timer.unref?.();
    this.timers.set(scopeKey, timer);
  }

  private async syncScope(kind: string, id: string): Promise<void> {
    const projectIds = kind === 'project' ? [id] : (await this.deps.store.listOrganizationProjects(id)).map((project) => project.id);
    await this.syncProjects(projectIds);
  }

  private async syncProjects(projectIds: string[]): Promise<void> {
    const done = new Set<string>();
    for (const projectId of projectIds) {
      if (this.stopped) return;
      try { await this.syncProjectRepositories(projectId, undefined, done); }
      catch (error) { this.deps.log?.(`GitHub access sync for project ${projectId} failed: ${message(error)}`); }
    }
  }

  /** Every project with a GitHub-connected repository (code or wiki), or one it
   * stopped using that tavya gave access to, one after another: catches up on
   * changes made while nothing was listening (a restart between commit and sync).
   * A repository several projects share is synced once. */
  async sweep(): Promise<void> {
    const projectIds: string[] = [];
    for (const project of await this.deps.store.listProjects()) {
      if ((await this.projectRepositoryIds(project.id)).length || (await this.tracked(project.id)).length) projectIds.push(project.id);
    }
    await this.syncProjects(projectIds);
  }

  /** Follow access changes and newly linked GitHub accounts. */
  watch(app: Pick<GitHubAppService, 'onUserAccountsChanged'>): () => void {
    this.stops.push(this.deps.store.onAccessChanged((scopeKey) => this.schedule(scopeKey)));
    this.stops.push(app.onUserAccountsChanged((userId) => {
      void this.deps.store.listOrganizations(userId).then((organizations) => {
        for (const organization of organizations) this.schedule(`organization:${organization.id}`);
      }).catch(() => undefined);
    }));
    return () => this.stop();
  }

  stop(): void {
    this.stopped = true;
    for (const stop of this.stops.splice(0)) stop();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
