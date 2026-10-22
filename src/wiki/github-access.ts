import type { Project, Repository } from '../domain/types.js';
import type { Store } from '../store/db.js';
import type { AuthorizationService } from '../platform/authorization.js';
import { allows } from '../platform/capabilities.js';
import { GITHUB_REPOSITORY_ROLES, type GitHubAppService, type GitHubRepositoryRole } from '../integrations/github-app.js';

/**
 * GitHub access to project wiki repositories follows access in tavya.
 *
 * tavya creates each project's wiki repository in the account of whoever
 * installed its GitHub App, so nobody else can see it on GitHub. Pull requests
 * are opened as the task's creator, and GitHub answers a person who cannot see
 * a private repository with 404 — so every other member's task that touched the
 * wiki failed to open its pull request (andhbhakt.com #8, video-explainers #4).
 *
 * Whoever may edit the wiki in tavya (`skill:write`) is a collaborator with
 * push, whoever may only read it (`project:read`) with pull, through every
 * GitHub account they linked. The invitation is accepted as them at once. Only
 * access tavya gave is ever taken back: the owner and people added by hand keep
 * theirs, and a role tavya raised returns to what it was.
 */

type GithubAccessApp = Pick<GitHubAppService, 'listUserAccounts' | 'repositoryCollaborators' | 'repositoryInvitations'
  | 'addRepositoryCollaborator' | 'acceptRepositoryInvitation' | 'removeRepositoryCollaborator'>;

export interface WikiAccessGrant {
  userId: string;
  accountId: string;
  login: string;
  role: GitHubRepositoryRole;
  /** The role the person had before tavya raised it; restored, not removed, when access ends. */
  previousRole?: GitHubRepositoryRole;
}

export interface WikiAccessOutcome {
  userId: string;
  login: string;
  /** `invited`: GitHub holds an invitation tavya could not accept for them. */
  state: 'member' | 'invited' | 'owner' | 'failed';
  detail?: string;
}

const grantsKey = (repositoryId: string) => `wiki-github-access:${repositoryId}`;
const rank = (role: GitHubRepositoryRole) => GITHUB_REPOSITORY_ROLES.indexOf(role);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

export class WikiGithubAccess {
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

  /** The role on GitHub that matches what the person may do with the wiki in tavya. */
  async roleFor(userId: string, project: Project): Promise<GitHubRepositoryRole | undefined> {
    if (!this.deps.authorization)
      return (await this.deps.store.organizationMembership(project.organizationId ?? 'org_personal', userId)) ? 'push' : undefined;
    const caps = await this.deps.authorization.capabilitiesAsync(`user:${userId}`, project.id, project.organizationId);
    return allows(caps, 'skill:write') ? 'push' : allows(caps, 'project:read') ? 'pull' : undefined;
  }

  /**
   * Bring the project wiki repository's collaborators in line with tavya. With
   * `onlyUserId`, only that person is granted access (nobody loses any): what a
   * pull request opened as them needs first.
   */
  async syncProject(projectId: string, onlyUserId?: string): Promise<WikiAccessOutcome[]> {
    return this.inLane(projectId, () => this.reconcile(projectId, onlyUserId));
  }

  private async reconcile(projectId: string, onlyUserId?: string): Promise<WikiAccessOutcome[]> {
    const { store, githubApp } = this.deps;
    const project = await store.getProject(projectId);
    const repository = (await store.projectWiki(projectId))?.repository;
    if (!project || !repository?.gitConnectionId) return [];
    const granted = await this.grants(repository.id);
    const userIds = onlyUserId ? [onlyUserId] : [...new Set([
      ...(await store.listOrganizationMemberships(project.organizationId ?? 'org_personal')).map((member) => member.userId),
      ...(await store.listProjectMemberships(projectId)).flatMap((member) =>
        member.principal.kind === 'user' ? [member.principal.userId] : []),
      ...Object.values(granted).map((grant) => grant.userId),
    ])];
    const wanted = new Map<string, Omit<WikiAccessGrant, 'previousRole'>>();
    for (const userId of userIds) {
      const role = await this.roleFor(userId, project);
      if (!role) continue;
      for (const account of await githubApp.listUserAccounts(userId).catch(() => []))
        wanted.set(account.login.toLowerCase(), { userId, accountId: account.id, login: account.login, role });
    }
    if (onlyUserId && !wanted.size) return [];
    const collaborators = new Map((await githubApp.repositoryCollaborators(repository))
      .map((collaborator) => [collaborator.login.toLowerCase(), collaborator.role]));
    const invitations = new Map((await githubApp.repositoryInvitations(repository))
      .map((invitation) => [invitation.login.toLowerCase(), invitation]));
    const outcomes: WikiAccessOutcome[] = [];
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

  private async grant(repository: Repository, want: Omit<WikiAccessGrant, 'previousRole'>,
    have: GitHubRepositoryRole | undefined, invitation: { id: number; role: GitHubRepositoryRole } | undefined,
    mine: WikiAccessGrant | undefined): Promise<WikiAccessOutcome> {
    const { githubApp } = this.deps;
    const member = { userId: want.userId, login: want.login };
    // Someone else's access that already covers the wiki is theirs to keep;
    // tavya's own grant follows the person's role in tavya, down as well as up.
    if (have && (mine ? have === want.role : rank(have) >= rank(want.role))) {
      if (mine && (mine.accountId !== want.accountId || mine.userId !== want.userId))
        await this.record(repository.id, want.login, { ...mine, ...want });
      return { ...member, state: 'member' };
    }
    let invitationId = !have && invitation?.role === want.role ? invitation.id : undefined;
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

  private async revoke(repository: Repository, grant: WikiAccessGrant, collaborator: boolean, invitationId?: number): Promise<void> {
    const { githubApp } = this.deps;
    if (collaborator && grant.previousRole) await githubApp.addRepositoryCollaborator(repository, grant.login, grant.previousRole);
    else if (collaborator) await githubApp.removeRepositoryCollaborator(repository, grant.login);
    else if (invitationId !== undefined) await githubApp.removeRepositoryCollaborator(repository, grant.login, invitationId);
    await this.record(repository.id, grant.login, undefined);
  }

  /** Access tavya gave on one repository, by lower-cased login. */
  async grants(repositoryId: string): Promise<Record<string, WikiAccessGrant>> {
    try {
      const value = JSON.parse((await this.deps.store.kvGet(grantsKey(repositoryId))) ?? '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  }

  private async record(repositoryId: string, login: string, grant: WikiAccessGrant | undefined): Promise<void> {
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

  /** One sync per project at a time in this process; GitHub calls stay ordered. */
  private inLane<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.lanes.get(projectId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    const settled = next.catch(() => undefined);
    this.lanes.set(projectId, settled);
    void settled.then(() => { if (this.lanes.get(projectId) === settled) this.lanes.delete(projectId); });
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
      void this.syncScope(kind, id).catch((error) => this.deps.log?.(`wiki access sync for ${scopeKey} failed: ${message(error)}`));
    }, this.deps.debounceMs ?? 2_000);
    timer.unref?.();
    this.timers.set(scopeKey, timer);
  }

  private async syncScope(kind: string, id: string): Promise<void> {
    const projectIds = kind === 'project' ? [id] : (await this.deps.store.listOrganizationProjects(id)).map((project) => project.id);
    for (const projectId of projectIds) {
      try { await this.syncProject(projectId); }
      catch (error) { this.deps.log?.(`wiki access sync for project ${projectId} failed: ${message(error)}`); }
    }
  }

  /** Every project wiki with a GitHub repository, one after another: catches up
   * on changes made while nothing was listening (a restart between commit and sync). */
  async sweep(): Promise<void> {
    for (const project of await this.deps.store.listProjects()) {
      if (this.stopped) return;
      if (!(await this.deps.store.projectWiki(project.id))?.repository?.gitConnectionId) continue;
      try { await this.syncProject(project.id); }
      catch (error) { this.deps.log?.(`wiki access sync for project ${project.id} failed: ${message(error)}`); }
    }
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
