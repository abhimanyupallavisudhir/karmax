import type { Repository } from '../domain/types.js';
import type { Store } from '../store/db.js';
import type { GitHubAppService } from './github-app.js';
import { newId } from '../util/id.js';

/**
 * Asking for GitHub access to a repository a task's creator cannot see.
 *
 * Pull requests are opened as the task's creator, so the work stays theirs on
 * GitHub. When GitHub hides the repository from them, the people who can fix it
 * are the repository's GitHub admins: tavya asks those who are members of the
 * organization, and an approval adds the creator as a collaborator through the
 * App, accepts the invitation as them and retries the task. A tavya role alone
 * never grants GitHub access: the approver must be an admin on GitHub, checked
 * again when they decide.
 */

export interface RepositoryAccessRequest {
  id: string;
  type: 'repository-access';
  organizationId: string;
  taskId: string;
  projectId: string;
  repositoryId: string;
  slug: string;
  /** The person who needs access, and the GitHub account they act through. */
  userId: string;
  accountId?: string;
  login: string;
  role: 'push';
  /** The repository's GitHub admins among the organization's members. */
  approvers: Array<{ userId: string; login: string }>;
  recipients: string[];
  status: 'pending' | 'granted' | 'denied' | 'withdrawn';
  /** Ignored: it notifies nobody, and stays decidable from the task's Approval requests. */
  dismissed?: { by: string; at: number };
  resolution?: { action: 'approve' | 'deny'; by: string; at: number };
  createdAt: number;
  /** Projected for display, never persisted. */
  task?: { id: string; num?: number; title: string; projectId: string };
}

type AccessApp = Pick<GitHubAppService, 'listUserAccounts' | 'repositoryCollaborators' | 'addRepositoryCollaborator'
  | 'acceptRepositoryInvitation'>;

const prefix = (organizationId: string, taskId?: string) =>
  `repository-access:request:${organizationId}:${taskId === undefined ? '' : `${taskId}:`}`;
const keyOf = (request: Pick<RepositoryAccessRequest, 'organizationId' | 'taskId' | 'id'>) =>
  `${prefix(request.organizationId, request.taskId)}${request.id}`;

/** A task's pending requests, withdrawn once it is done or cancelled: no decision could reach it. */
export async function withdrawRepositoryAccessRequests(store: Pick<Store, 'transaction' | 'lock' | 'kvGet' | 'kvSet' | 'kvEntries'>,
  organizationId: string, taskId: string): Promise<RepositoryAccessRequest[]> {
  const withdrawn: RepositoryAccessRequest[] = [];
  for (const { key } of await store.kvEntries(prefix(organizationId, taskId))) {
    const request = await store.transaction(async () => {
      await store.lock(`kv:${key}`);
      const current = JSON.parse((await store.kvGet(key)) ?? 'null') as RepositoryAccessRequest | null;
      if (current?.status !== 'pending') return undefined;
      const next: RepositoryAccessRequest = { ...current, status: 'withdrawn' };
      await store.kvSet(key, JSON.stringify(next));
      return next;
    });
    if (request) withdrawn.push(request);
  }
  return withdrawn;
}

/** Tasks a pending request still asks someone about, in one organization. */
export async function tasksWithPendingRepositoryAccess(store: Pick<Store, 'kvEntries'>, organizationId: string): Promise<string[]> {
  return (await store.kvEntries(prefix(organizationId))).flatMap(({ value }) => {
    try {
      const request = JSON.parse(value) as RepositoryAccessRequest;
      return request.status === 'pending' && !request.dismissed ? [request.taskId] : [];
    } catch { return []; }
  });
}

export class RepositoryAccessRequests {
  constructor(private deps: {
    store: Pick<Store, 'transaction' | 'lock' | 'kvGet' | 'kvSet' | 'kvEntries' | 'appendEvent' | 'getTask' | 'getProject'
      | 'getRepository' | 'listOrganizationMemberships'>;
    githubApp: AccessApp;
    /** Run the task's failed stage again (its Retry). */
    retry?: (taskId: string) => Promise<unknown>;
    emit?: (event: { taskId: string; type: string; ts: number; payload: Record<string, unknown>; seq: number }) => void;
  }) {}

  /** The repository's GitHub admins who are members of the organization, as GitHub says now. */
  async approvers(repository: Repository, except?: string): Promise<Array<{ userId: string; login: string }>> {
    const admins = new Set((await this.deps.githubApp.repositoryCollaborators(repository))
      .filter((collaborator) => collaborator.role === 'admin').map((collaborator) => collaborator.login.toLowerCase()));
    const found: Array<{ userId: string; login: string }> = [];
    for (const member of await this.deps.store.listOrganizationMemberships(repository.organizationId)) {
      if (member.userId === except) continue;
      const account = (await this.deps.githubApp.listUserAccounts(member.userId).catch(() => []))
        .find((candidate) => admins.has(candidate.login.toLowerCase()));
      if (account) found.push({ userId: member.userId, login: account.login });
    }
    return found;
  }

  async requests(organizationId: string, filter: { taskId?: string; status?: RepositoryAccessRequest['status'] } = {}): Promise<RepositoryAccessRequest[]> {
    const entries = await this.deps.store.kvEntries(prefix(organizationId, filter.taskId));
    return entries.flatMap(({ value }) => {
      try { return [JSON.parse(value) as RepositoryAccessRequest]; } catch { return []; }
    }).filter((request) => !filter.status || request.status === filter.status)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Ask the repository's admins to give `login` access, once per task and repository. */
  async request(input: { taskId: string; repository: Repository; userId: string; accountId?: string; login: string }):
  Promise<RepositoryAccessRequest | undefined> {
    const task = await this.deps.store.getTask(input.taskId);
    if (!task) return undefined;
    const organizationId = input.repository.organizationId;
    const pending = (await this.requests(organizationId, { taskId: task.id, status: 'pending' }))
      .find((request) => request.repositoryId === input.repository.id && request.login.toLowerCase() === input.login.toLowerCase());
    if (pending) return pending;
    const approvers = await this.approvers(input.repository, input.userId);
    if (!approvers.length) return undefined;
    const request: RepositoryAccessRequest = {
      id: newId('repoaccess'), type: 'repository-access', organizationId, taskId: task.id, projectId: task.projectId,
      repositoryId: input.repository.id, slug: `${input.repository.owner}/${input.repository.name}`,
      userId: input.userId, ...(input.accountId ? { accountId: input.accountId } : {}), login: input.login, role: 'push',
      approvers, recipients: [...new Set(approvers.map((approver) => approver.userId))], status: 'pending', createdAt: Date.now(),
    };
    await this.deps.store.kvSet(keyOf(request), JSON.stringify(request));
    await this.record(task.id, 'repository-access.approval-requested', {
      requestId: request.id, slug: request.slug, login: request.login, recipients: request.recipients, urgency: 'high',
    });
    return request;
  }

  /** Ignore a request: no more notifications; it can still be decided. */
  async dismiss(input: { organizationId: string; requestId: string; userId: string }): Promise<RepositoryAccessRequest> {
    const found = (await this.requests(input.organizationId)).find((request) => request.id === input.requestId);
    if (!found) throw new AccessRequestError(404, `no GitHub access request ${input.requestId}`);
    if (!found.recipients.includes(input.userId)) throw new AccessRequestError(403, 'this GitHub access request was not routed to you');
    const key = keyOf(found);
    const dismissed = await this.deps.store.transaction(async () => {
      await this.deps.store.lock(`kv:${key}`);
      const current = JSON.parse((await this.deps.store.kvGet(key)) ?? 'null') as RepositoryAccessRequest | null;
      if (!current || current.status !== 'pending') return undefined;
      const next: RepositoryAccessRequest = { ...current, dismissed: current.dismissed ?? { by: `user:${input.userId}`, at: Date.now() } };
      await this.deps.store.kvSet(key, JSON.stringify(next));
      return next;
    });
    if (!dismissed) throw new AccessRequestError(409, `GitHub access request ${found.id} is already ${found.status}`);
    await this.record(dismissed.taskId, 'repository-access.approval-dismissed', { requestId: dismissed.id });
    return dismissed;
  }

  /** An approver's decision. Approval gives access at once and retries the task. */
  async resolve(input: { organizationId: string; requestId: string; userId: string; action: 'approve' | 'deny' }):
  Promise<RepositoryAccessRequest & { retried: boolean }> {
    const found = (await this.requests(input.organizationId)).find((request) => request.id === input.requestId);
    if (!found) throw new AccessRequestError(404, `no GitHub access request ${input.requestId}`);
    if (!found.recipients.includes(input.userId)) throw new AccessRequestError(403, 'this GitHub access request was not routed to you');
    const key = keyOf(found);
    // One decision per request, on any gateway replica.
    const claimed = await this.deps.store.transaction(async () => {
      await this.deps.store.lock(`kv:${key}`);
      const current = JSON.parse((await this.deps.store.kvGet(key)) ?? 'null') as RepositoryAccessRequest | null;
      if (!current || current.status !== 'pending') return undefined;
      const deciding = { ...current, status: input.action === 'approve' ? 'granted' : 'denied',
        resolution: { action: input.action, by: input.userId, at: Date.now() } } as RepositoryAccessRequest;
      await this.deps.store.kvSet(key, JSON.stringify(deciding));
      return { current, deciding };
    });
    if (!claimed) throw new AccessRequestError(409, `GitHub access request ${found.id} is already ${found.status}`);
    const { current, deciding } = claimed;
    if (input.action === 'approve') {
      try {
        const repository = await this.deps.store.getRepository(current.repositoryId);
        if (!repository) throw new AccessRequestError(404, `repository ${current.slug} is no longer connected`);
        // Admin on GitHub when they decide, not only when they were asked.
        if (!(await this.approvers(repository)).some((approver) => approver.userId === input.userId))
          throw new AccessRequestError(403, `Only an admin of ${current.slug} on GitHub can give access to it`);
        const added = await this.deps.githubApp.addRepositoryCollaborator(repository, current.login, current.role);
        // Accepting as them makes access immediate; if GitHub refuses, the next
        // pull request accepts the pending invitation itself (openPr).
        if (added.invitationId !== undefined && current.accountId)
          await this.deps.githubApp.acceptRepositoryInvitation(current.userId, current.accountId, added.invitationId).catch(() => undefined);
      } catch (error) {
        await this.deps.store.kvSet(key, JSON.stringify(current));
        throw error;
      }
    }
    await this.record(current.taskId, 'repository-access.approval-resolved', {
      requestId: current.id, action: input.action, by: input.userId, slug: current.slug, login: current.login,
    });
    const retried = input.action === 'approve' && this.deps.retry
      ? await this.deps.retry(current.taskId).then(() => true, () => false) : false;
    return { ...deciding, retried };
  }

  private async record(taskId: string, type: string, payload: Record<string, unknown>): Promise<void> {
    const event = { taskId, type, ts: Date.now(), payload };
    const seq = await this.deps.store.appendEvent(event);
    this.deps.emit?.({ ...event, seq });
  }
}

export class AccessRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'AccessRequestError';
  }
}
