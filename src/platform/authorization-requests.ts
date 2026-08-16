import type { AuthorizationSelection } from '../domain/types.js';
import type { Store } from '../store/db.js';
import { newId } from '../util/id.js';
import type { Capability } from './capabilities.js';

export type AuthorizationRequestTarget =
  | { kind: 'task'; taskId: string; queueAfterApproval?: boolean }
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
  resolution?: { action: 'approve' | 'deny'; by: string; at: number };
  createdAt: number;
}

const key = (organizationId: string) => `authorization:requests:${organizationId}`;

/** Durable approval requests for delegating a job-shaped authorization package.
 * Unlike agent permission requests these never elevate the requester: approval
 * is applied directly to the named task or Avatar. */
export class AuthorizationRequests {
  constructor(private store: Pick<Store, 'kvGet' | 'kvSet' | 'appendAudit'>, private organizationId: string) {}

  requests(filter: { status?: AuthorizationRequest['status']; taskId?: string; avatarId?: string } = {}): AuthorizationRequest[] {
    let all: AuthorizationRequest[] = [];
    try {
      const raw = this.store.kvGet(key(this.organizationId));
      all = raw ? JSON.parse(raw) : [];
    } catch { all = []; }
    return all.filter((request) => (!filter.status || request.status === filter.status)
      && (!filter.taskId || request.target.kind === 'task' && request.target.taskId === filter.taskId)
      && (!filter.avatarId || request.target.kind === 'avatar' && request.target.avatarId === filter.avatarId));
  }

  request(input: Omit<AuthorizationRequest, 'id' | 'type' | 'organizationId' | 'status' | 'createdAt'>): AuthorizationRequest {
    const audience = [...new Set(input.audience.map(String).map((value) => value.trim()).filter(Boolean))];
    const recipients = [...new Set(input.recipients.map(String).filter(Boolean))];
    const avatarRecipients = [...new Set((input.avatarRecipients ?? []).map(String).filter(Boolean))];
    if (!audience.length || (!recipients.length && !avatarRecipients.length))
      throw new Error('choose at least one eligible person, team, or Avatar');
    const all = this.requests();
    const targetKey = input.target.kind === 'task' ? `task:${input.target.taskId}` : `avatar:${input.target.avatarId}`;
    const existing = all.find((request) => request.status === 'pending'
      && (request.target.kind === 'task' ? `task:${request.target.taskId}` : `avatar:${request.target.avatarId}`) === targetKey);
    if (existing) return existing;
    const request: AuthorizationRequest = {
      ...input,
      id: newId('areq'), type: 'authorization', organizationId: this.organizationId,
      audience, recipients, ...(avatarRecipients.length ? { avatarRecipients } : {}),
      status: 'pending', createdAt: Date.now(),
    };
    this.save([...all, request]);
    this.store.appendAudit({
      principalId: input.requestedBy,
      action: 'authorization.requested',
      scopeKey: `project:${input.projectId}`,
      detail: { requestId: request.id, target: request.target, authorization: request.authorization,
        missingCapabilities: request.missingCapabilities, audience, recipients, avatarRecipients },
    });
    return request;
  }

  resolve(id: string, action: 'approve' | 'deny', by: string): AuthorizationRequest {
    const all = this.requests();
    const request = all.find((candidate) => candidate.id === id);
    if (!request) throw new Error(`no authorization request ${id}`);
    if (request.status !== 'pending') throw new Error(`request ${id} is already ${request.status}`);
    request.status = action === 'approve' ? 'granted' : 'denied';
    request.resolution = { action, by, at: Date.now() };
    this.save(all);
    this.store.appendAudit({
      principalId: by,
      action: 'authorization.request.resolved',
      scopeKey: `project:${request.projectId}`,
      detail: { requestId: request.id, target: request.target, authorization: request.authorization, action },
    });
    return request;
  }

  private save(requests: AuthorizationRequest[]): void {
    this.store.kvSet(key(this.organizationId), JSON.stringify(requests));
  }
}
