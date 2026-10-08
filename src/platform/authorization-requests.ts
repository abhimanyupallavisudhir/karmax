import type { AuthorizationSelection } from '../domain/types.js';
import type { Store } from '../store/db.js';
import { newId } from '../util/id.js';
import type { Capability } from './capabilities.js';

export type AuthorizationRequestTarget =
  | { kind: 'task'; taskId: string; /** One of the task's agents other than the
       * main one (`responder`, `confirm-2`, `agent-3`); absent ⇒ the task's own. */
      participant?: string; queueAfterApproval?: boolean }
  | { kind: 'avatar'; avatarId: string; enableAfterApproval?: boolean };

export interface AuthorizationRequest {
  id: string;
  type: 'authorization';
  organizationId: string;
  projectId: string;
  target: AuthorizationRequestTarget;
  authorization: AuthorizationSelection;
  /** Complete requested ceiling, snapshotted for recipient eligibility and the
   * approval check. The selection is still re-evaluated when approved. */
  capabilities: Capability[];
  missingCapabilities: Capability[];
  audience: string[];
  recipients: string[];
  avatarRecipients?: string[];
  reason: string;
  requestedBy: string;
  status: 'pending' | 'granted' | 'denied';
  claim?: { id: string; action: 'approve' | 'deny'; by: string; at: number };
  dismissed?: { by: string; at: number };
  resolution?: { action: 'approve' | 'deny'; by: string; at: number };
  createdAt: number;
}

const key = (organizationId: string) => `authorization:requests:${organizationId}`;

/** Durable approval requests for delegating a job-shaped authorization package.
 * Unlike agent permission requests these never elevate the requester: approval
 * is applied directly to the named task or Avatar. */
export class AuthorizationRequests {
  constructor(private store: Pick<Store, 'transaction' | 'kvGet' | 'kvSet' | 'appendAudit'> & Partial<Pick<Store, 'lock'>>,
    private organizationId: string) {}

  /** The organization's requests are one kv value, rewritten under its lock. */
  private async locked(): Promise<void> { await this.store.lock?.(`kv:${key(this.organizationId)}`); }

  async requests(filter: { status?: AuthorizationRequest['status']; taskId?: string; avatarId?: string } = {}): Promise<AuthorizationRequest[]> {
    let all: AuthorizationRequest[] = [];
    try {
      const raw = (await this.store.kvGet(key(this.organizationId)));
      all = raw ? JSON.parse(raw) : [];
    } catch { all = []; }
    return all.filter((request) => (!filter.status || request.status === filter.status)
      && (!filter.taskId || request.target.kind === 'task' && request.target.taskId === filter.taskId)
      && (!filter.avatarId || request.target.kind === 'avatar' && request.target.avatarId === filter.avatarId));
  }

  async request(input: Omit<AuthorizationRequest, 'id' | 'type' | 'organizationId' | 'status' | 'createdAt' | 'claim'>): Promise<AuthorizationRequest> {
    return this.store.transaction(async () => {
    await this.locked();
    const audience = [...new Set(input.audience.map(String).map((value) => value.trim()).filter(Boolean))];
    const recipients = [...new Set(input.recipients.map(String).filter(Boolean))];
    const avatarRecipients = [...new Set((input.avatarRecipients ?? []).map(String).filter(Boolean))];
    if (!audience.length || (!recipients.length && !avatarRecipients.length))
      throw new Error('choose at least one eligible person, team, or Avatar');
    const all = (await this.requests());
    const keyOf = (target: AuthorizationRequestTarget) => target.kind === 'task'
      ? `task:${target.taskId}${target.participant ? `#${target.participant}` : ''}` : `avatar:${target.avatarId}`;
    const existing = all.find((request) => request.status === 'pending' && keyOf(request.target) === keyOf(input.target));
    if (existing) return existing;
    const request: AuthorizationRequest = {
      ...input,
      id: newId('areq'), type: 'authorization', organizationId: this.organizationId,
      audience, recipients, ...(avatarRecipients.length ? { avatarRecipients } : {}),
      status: 'pending', createdAt: Date.now(),
    };
    (await this.save([...all, request]));
    (await this.store.appendAudit({
      principalId: input.requestedBy,
      action: 'authorization.requested',
      scopeKey: `project:${input.projectId}`,
      detail: { requestId: request.id, target: request.target, authorization: request.authorization,
        missingCapabilities: request.missingCapabilities, audience, recipients, avatarRecipients },
    }));
    return request;

    });
  }

  /** Keep the claim until completion: applying a grant can cross service
   * boundaries, so expiring it could admit a conflicting decision mid-apply. */
  async claim(id: string, action: 'approve' | 'deny', by: string): Promise<string> {
    return this.store.transaction(async () => {
    await this.locked();
      const all = await this.requests();
      const request = all.find((candidate) => candidate.id === id);
      if (!request) throw new Error(`no authorization request ${id}`);
      if (request.status !== 'pending') throw new Error(`request ${id} is already ${request.status}`);
      if (request.claim) throw new Error('authorization request decision is already in progress');
      request.claim = { id: newId('claim'), action, by, at: Date.now() };
      await this.save(all);
      return request.claim.id;
    });
  }

  async resolve(id: string, action: 'approve' | 'deny', by: string, claimId?: string): Promise<AuthorizationRequest> {
    return this.store.transaction(async () => {
    await this.locked();
    const all = (await this.requests());
    const request = all.find((candidate) => candidate.id === id);
    if (!request) throw new Error(`no authorization request ${id}`);
    if (request.status !== 'pending') throw new Error(`request ${id} is already ${request.status}`);
    if (request.claim && (request.claim.id !== claimId || request.claim.action !== action || request.claim.by !== by))
      throw new Error('authorization request decision is already in progress');
    if (claimId && !request.claim) throw new Error('authorization request decision claim is no longer active');
    delete request.claim;
    request.status = action === 'approve' ? 'granted' : 'denied';
    request.resolution = { action, by, at: Date.now() };
    (await this.save(all));
    (await this.store.appendAudit({
      principalId: by,
      action: 'authorization.request.resolved',
      scopeKey: `project:${request.projectId}`,
      detail: { requestId: request.id, target: request.target, authorization: request.authorization, action },
    }));
    return request;

    });
  }

  async dismiss(id: string, by: string): Promise<AuthorizationRequest> {
    return this.store.transaction(async () => {
    await this.locked();
    const all = (await this.requests());
    const request = all.find((candidate) => candidate.id === id);
    if (!request) throw new Error(`no authorization request ${id}`);
    if (request.status !== 'pending') throw new Error(`request ${id} is already ${request.status}`);
    if (request.claim) throw new Error('authorization request decision is already in progress');
    request.dismissed ??= { by, at: Date.now() };
    (await this.save(all));
    (await this.store.appendAudit({ principalId: by, action: 'authorization.request.dismissed',
      scopeKey: `project:${request.projectId}`, detail: { requestId: id } }));
    return request;

    });
  }

  private async save(requests: AuthorizationRequest[]): Promise<void> {
    (await this.store.kvSet(key(this.organizationId), JSON.stringify(requests)));
  }
}
