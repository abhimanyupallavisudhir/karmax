import type { AuthorizationSelection } from '../domain/types.js';
import type { Store } from '../store/db.js';
import { newId } from '../util/id.js';
import { CAPABILITIES, type Capability } from './capabilities.js';

export interface PermissionRequest {
  id: string;
  type: 'permission';
  taskId: string;
  projectId: string;
  role: string;
  capabilities: Capability[];
  /** Additive task scope change; approval also revalidates the existing grant. */
  projectIds?: string[];
  baseAuthorization?: AuthorizationSelection;
  audience: string[];
  /** Materialized at request time so later membership changes cannot widen who
   * may decide an already-pending elevation. */
  recipients: string[];
  /** Avatar principals selected at request time. Kept separate from human ids
   * so the inbox never attempts to materialize an Avatar as a user. */
  avatarRecipients?: string[];
  reason: string;
  requestedBy: string;
  status: 'pending' | 'granted' | 'denied';
  dismissed?: { by: string; at: number };
  resolution?: { action: 'approve' | 'deny'; by: string; at: number };
  createdAt: number;
  /** Human-facing metadata projected by the gateway, never persisted. */
  task?: { id: string; num?: number; title: string; projectId: string };
}

const requestsKey = (organizationId: string) => `permission:requests:${organizationId}`;
const extensionsKey = (taskId: string) => `permission:grant:${taskId}`;
const concretePrefixes = ['merge-into:', 'use-credential:', 'use-card:'];

export function exactCapability(raw: string): Capability {
  const capability = String(raw).trim();
  if (!capability || capability.includes('*'))
    throw new Error('permission requests must name exact capabilities (wildcards are not allowed)');
  if (!CAPABILITIES.includes(capability as any)
    && !concretePrefixes.some((prefix) => capability.startsWith(prefix) && capability.length > prefix.length))
    throw new Error(`unknown capability ${capability}`);
  return capability;
}

/**
 * Durable, organization-scoped approval requests for explicit task elevation.
 * Approved capabilities are stored as task extensions and folded into both
 * axes of the next turn's scoped token. Nothing mutates a human/profile grant.
 */
export class PermissionRequests {
  constructor(private store: Pick<Store, 'kvGet' | 'kvSet' | 'appendAudit'>, private organizationId: string) {}

  async requests(filter: { taskId?: string; status?: PermissionRequest['status'] } = {}): Promise<PermissionRequest[]> {
    let all: PermissionRequest[] = [];
    try {
      const raw = (await this.store.kvGet(requestsKey(this.organizationId)));
      all = raw ? JSON.parse(raw) : [];
    } catch {
      all = [];
    }
    return all.filter((request) => (!filter.taskId || request.taskId === filter.taskId)
      && (!filter.status || request.status === filter.status));
  }

  async extensionCaps(taskId: string, role?: string): Promise<Capability[]> {
    try {
      const raw = (await this.store.kvGet(extensionsKey(taskId)));
      const grants = raw ? JSON.parse(raw) : {};
      // Compatibility with the short-lived development representation.
      if (Array.isArray(grants)) return grants.map(String);
      if (!grants || typeof grants !== 'object') return [];
      if (role) return Array.isArray(grants[role]) ? grants[role].map(String) : [];
      return [...new Set(Object.values(grants).flatMap((caps) => Array.isArray(caps) ? caps.map(String) : []))];
    } catch {
      return [];
    }
  }

  async request(input: {
    taskId: string;
    projectId: string;
    role: string;
    capabilities: Capability[];
    projectIds?: string[];
    baseAuthorization?: AuthorizationSelection;
    audience: string[];
    recipients: string[];
    avatarRecipients?: string[];
    reason: string;
    requestedBy: string;
  }): Promise<PermissionRequest> {
    const capabilities = [...new Set(input.capabilities.map(exactCapability))];
    const projectIds = [...new Set((input.projectIds ?? []).map(String))];
    if (!capabilities.length && !projectIds.length) throw new Error('choose at least one capability or project');
    if (capabilities.length > 32) throw new Error('at most 32 capabilities may be requested');
    const audience = [...new Set(input.audience.map((value) => String(value).trim()).filter(Boolean))];
    const recipients = [...new Set(input.recipients.map(String).filter(Boolean))];
    const avatarRecipients = [...new Set((input.avatarRecipients ?? []).map(String).filter(Boolean))];
    if (!audience.length || (!recipients.length && !avatarRecipients.length)) throw new Error('choose at least one person, team, or Avatar');
    const reason = String(input.reason).trim();
    if (!reason) throw new Error('reason is required');
    if ([...reason].length > 4_000) throw new Error('reason must be at most 4000 characters');

    const all = (await this.requests());
    const fingerprint = (values: string[]) => [...values].sort().join('\0');
    const existing = all.find((request) => request.status === 'pending'
      && request.taskId === input.taskId
      && request.role === input.role
      && fingerprint(request.capabilities) === fingerprint(capabilities)
      && fingerprint(request.projectIds ?? []) === fingerprint(projectIds)
      && JSON.stringify(request.baseAuthorization) === JSON.stringify(input.baseAuthorization)
      && fingerprint(request.audience) === fingerprint(audience));
    if (existing) return existing;

    const request: PermissionRequest = {
      id: newId('preq'),
      type: 'permission',
      taskId: input.taskId,
      projectId: input.projectId,
      role: input.role,
      capabilities,
      ...(projectIds.length ? { projectIds, baseAuthorization: input.baseAuthorization } : {}),
      audience,
      recipients,
      ...(avatarRecipients.length ? { avatarRecipients } : {}),
      reason,
      requestedBy: input.requestedBy,
      status: 'pending',
      createdAt: Date.now(),
    };
    (await this.save([...all, request]));
    (await this.store.appendAudit({
      principalId: input.requestedBy,
      action: 'permission.requested',
      scopeKey: `project:${input.projectId}`,
      detail: { requestId: request.id, taskId: input.taskId, role: input.role, capabilities, projectIds, baseAuthorization: input.baseAuthorization, audience, recipients, avatarRecipients },
    }));
    return request;
  }

  async resolve(requestId: string, input: { action: 'approve' | 'deny'; by: string; alreadyAuthorized?: boolean }): Promise<PermissionRequest> {
    const all = (await this.requests());
    const request = all.find((candidate) => candidate.id === requestId);
    if (!request) throw new Error(`no permission request ${requestId}`);
    if (request.status !== 'pending') throw new Error(`request ${requestId} is already ${request.status}`);
    if (input.action === 'approve' && !input.alreadyAuthorized) {
      let grants: Record<string, Capability[]> = {};
      try {
        const raw = (await this.store.kvGet(extensionsKey(request.taskId)));
        const parsed = raw ? JSON.parse(raw) : {};
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) grants = parsed;
      } catch {}
      grants[request.role] = [...new Set([...(grants[request.role] ?? []), ...request.capabilities])];
      (await this.store.kvSet(extensionsKey(request.taskId), JSON.stringify(grants)));
    }
    request.status = input.action === 'approve' ? 'granted' : 'denied';
    request.resolution = { action: input.action, by: input.by, at: Date.now() };
    (await this.save(all));
    (await this.store.appendAudit({
      principalId: input.by,
      action: 'permission.request.resolved',
      scopeKey: `project:${request.projectId}`,
      detail: { requestId, taskId: request.taskId, role: request.role, capabilities: request.capabilities, projectIds: request.projectIds, action: input.action },
    }));
    return request;
  }

  async dismiss(id: string, by: string): Promise<PermissionRequest> {
    const all = (await this.requests());
    const request = all.find((candidate) => candidate.id === id);
    if (!request) throw new Error(`no permission request ${id}`);
    if (request.status !== 'pending') throw new Error(`request ${id} is already ${request.status}`);
    request.dismissed ??= { by, at: Date.now() };
    (await this.save(all));
    (await this.store.appendAudit({ principalId: by, action: 'permission.request.dismissed',
      scopeKey: `project:${request.projectId}`, detail: { requestId: id } }));
    return request;
  }

  private async save(requests: PermissionRequest[]): Promise<void> {
    (await this.store.kvSet(requestsKey(this.organizationId), JSON.stringify(requests)));
  }
}
