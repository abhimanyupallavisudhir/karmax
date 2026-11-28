import type { PermissionAsk } from '../domain/permission-ask.js';
import type { AuthorizationSelection } from '../domain/types.js';
import type { Store } from '../store/db.js';
import { newId } from '../util/id.js';
import { CAPABILITIES, type Capability } from './capabilities.js';
import type { DecisionMaker } from './decision-maker.js';
import { ConflictError } from './errors.js';
import type { Via } from './sub-task-asks.js';

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
  /** Tasks the requester acts for that hold what it asks: their agents decide.
   * A sub-task's parent that does not is one too, to decline it. */
  taskRecipients?: string[];
  /** A sub-task's request: the parent it came through, and its agent's note. */
  via?: Via;
  reason: string;
  requestedBy: string;
  status: 'pending' | 'granted' | 'denied' | 'withdrawn';
  dismissed?: { by: string; at: number };
  /** No decision is wanted any more: the requesting task's agent took it back
   * or the task settled while it was pending (PL-10). `by` is absent on
   * requests withdrawn before it was recorded. */
  withdrawn?: { by?: string; at: number; reason: string };
  resolution?: { action: 'approve' | 'deny'; by: string; at: number };
  createdAt: number;
  /** Human-facing metadata projected by the gateway, never persisted. */
  task?: { id: string; num?: number; title: string; projectId: string };
  /** What it grants, in words (src/domain/permission-ask.ts), projected the same way. */
  ask?: PermissionAsk;
  /** The tasks in `taskRecipients`, projected the same way. */
  grantorTasks?: Array<{ id: string; num?: number; title: string; projectId: string }>;
  /** Who decided it or took it back, in words (decision-maker.ts); projected, never persisted. */
  decidedBy?: DecisionMaker;
}

/** Before PL-8 every request of an organization lived in this one blob. */
const legacyRequestsKey = (organizationId: string) => `permission:requests:${organizationId}`;
/** One row per request, grouped by task: an ask or a decision rewrites only
 * its own row, and a task's requests are one key range. */
const permissionRequestPrefix = (organizationId: string, taskId?: string) =>
  `permission:request:${organizationId}:${taskId === undefined ? '' : `${taskId}:`}`;
const requestKey = (organizationId: string, request: Pick<PermissionRequest, 'taskId' | 'id'>) =>
  `${permissionRequestPrefix(organizationId, request.taskId)}${request.id}`;
const extensionsKey = (taskId: string) => `permission:grant:${taskId}`;
const claimKey = (requestId: string) => `permission:deciding:${requestId}`;
/** How long a decision may hold its claim. Long enough for a scope expansion's
 * workflow update; short enough that a replica that died mid-decision does
 * not strand the request. */
const CLAIM_TTL_MS = 5 * 60_000;
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
  constructor(private store: Pick<Store, 'transaction' | 'kvGet' | 'kvSet' | 'kvDelete' | 'kvEntries' | 'appendAudit'> & Partial<Pick<Store, 'lock'>>,
    private organizationId: string) {}

  /** A task's requests (and the grants they add) change under one lock. */
  private async lockTaskRequests(taskId: string): Promise<void> {
    await this.store.lock?.(`permission-requests:${this.organizationId}:${taskId}`, `kv:${extensionsKey(taskId)}`);
  }

  /** A request read under its task's lock. */
  private async lockedRequest(requestId: string): Promise<PermissionRequest | undefined> {
    const request = await this.find(requestId);
    if (!request || !this.store.lock) return request;
    await this.lockTaskRequests(request.taskId);
    return this.find(requestId);
  }

  /**
   * Claim the right to decide a request. Approving can widen the task's scope
   * before the request is marked resolved, so the claim — not the status check
   * — is what keeps a concurrent denial or second approval out. It lives in the
   * store, which every gateway replica shares. Returns undefined while another
   * decision holds an unexpired claim.
   */
  async claim(requestId: string): Promise<string | undefined> {
    return this.store.transaction(async () => {
      await this.store.lock?.(`kv:${claimKey(requestId)}`);
      if (await this.liveClaim(requestId)) return undefined;
      const claim = newId('pclaim');
      (await this.store.kvSet(claimKey(requestId), JSON.stringify({ claim, at: Date.now() })));
      return claim;
    });
  }

  /** Give up a claim (a decision that failed). Only the holder's claim is removed. */
  async release(requestId: string, claim: string): Promise<void> {
    return this.store.transaction(async () => {
      await this.store.lock?.(`kv:${claimKey(requestId)}`);
      if ((await this.liveClaim(requestId)) === claim) (await this.store.kvDelete(claimKey(requestId)));
    });
  }

  private async liveClaim(requestId: string): Promise<string | undefined> {
    try {
      const raw = (await this.store.kvGet(claimKey(requestId)));
      const held = raw ? JSON.parse(raw) : undefined;
      return held && Date.now() - Number(held.at) < CLAIM_TTL_MS ? String(held.claim) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Refuse a state change while a decision other than `claim` holds the request. */
  private async assertUnclaimed(requestId: string, claim?: string): Promise<void> {
    const held = (await this.liveClaim(requestId));
    if (held && held !== claim) throw new Error(`permission request ${requestId} decision is already in progress`);
  }

  async requests(filter: { taskId?: string; status?: PermissionRequest['status'] } = {}): Promise<PermissionRequest[]> {
    (await this.migrate());
    const all: PermissionRequest[] = [];
    for (const { value } of (await this.store.kvEntries(permissionRequestPrefix(this.organizationId, filter.taskId)))) {
      try { all.push(JSON.parse(value)); } catch { /* one malformed row must not hide the rest */ }
    }
    return all.filter((request) => !filter.status || request.status === filter.status)
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** Split the pre-PL-8 organization blob into rows, once. */
  private async migrate(): Promise<void> {
    if ((await this.store.kvGet(legacyRequestsKey(this.organizationId))) === undefined) return;
    return this.store.transaction(async () => {
      await this.store.lock?.(`kv:${legacyRequestsKey(this.organizationId)}`);
      const raw = (await this.store.kvGet(legacyRequestsKey(this.organizationId)));
      if (raw === undefined) return;
      let legacy: unknown;
      try { legacy = JSON.parse(raw); } catch { return; } // left for diagnosis, as before
      for (const request of Array.isArray(legacy) ? legacy as PermissionRequest[] : [])
        if (request?.id && request.taskId) (await this.save(request));
      (await this.store.kvDelete(legacyRequestsKey(this.organizationId)));
    });
  }

  private async find(requestId: string): Promise<PermissionRequest | undefined> {
    return (await this.requests()).find((candidate) => candidate.id === requestId);
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

  /** Add capabilities to what one of a task's agents was approved for. */
  private async extend(taskId: string, role: string, capabilities: Capability[]): Promise<void> {
    let grants: Record<string, Capability[]> = {};
    try {
      const raw = (await this.store.kvGet(extensionsKey(taskId)));
      const parsed = raw ? JSON.parse(raw) : {};
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) grants = parsed;
    } catch {}
    grants[role] = [...new Set([...(grants[role] ?? []), ...capabilities])];
    (await this.store.kvSet(extensionsKey(taskId), JSON.stringify(grants)));
  }

  /**
   * Start a new task's agent with capabilities approved for it already: what
   * its source's agent was approved for, carried on by someone who holds them
   * (`createTask`'s `permissionGrants`; a continuation, a re-authorized fork).
   */
  async grant(input: { taskId: string; projectId: string; role: string; capabilities: Capability[]; by: string; from?: string }): Promise<void> {
    if (!input.capabilities.length) return;
    return this.store.transaction(async () => {
      (await this.lockTaskRequests(input.taskId));
      (await this.extend(input.taskId, input.role, input.capabilities));
      (await this.store.appendAudit({
        principalId: input.by,
        action: 'permission.granted',
        scopeKey: `project:${input.projectId}`,
        detail: { taskId: input.taskId, role: input.role, capabilities: input.capabilities, ...(input.from ? { from: input.from } : {}) },
      }));
    });
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
    taskRecipients?: string[];
    via?: Via;
    reason: string;
    requestedBy: string;
  }): Promise<PermissionRequest> {
    return this.store.transaction(async () => {
    // One pending request per identical ask.
    (await this.lockTaskRequests(input.taskId));
    const capabilities = [...new Set(input.capabilities.map(exactCapability))];
    const projectIds = [...new Set((input.projectIds ?? []).map(String))];
    if (!capabilities.length && !projectIds.length) throw new Error('choose at least one capability or project');
    if (capabilities.length > 32) throw new Error('at most 32 capabilities may be requested');
    const audience = [...new Set(input.audience.map((value) => String(value).trim()).filter(Boolean))];
    const recipients = [...new Set(input.recipients.map(String).filter(Boolean))];
    const avatarRecipients = [...new Set((input.avatarRecipients ?? []).map(String).filter(Boolean))];
    const taskRecipients = [...new Set((input.taskRecipients ?? []).map(String).filter(Boolean))];
    if (!audience.length || (!recipients.length && !avatarRecipients.length && !taskRecipients.length))
      throw new Error('choose at least one task, person, team, or Avatar');
    const reason = String(input.reason).trim();
    if (!reason) throw new Error('reason is required');
    if ([...reason].length > 4_000) throw new Error('reason must be at most 4000 characters');

    const fingerprint = (values: string[]) => [...values].sort().join('\0');
    const existing = (await this.requests({ taskId: input.taskId })).find((request) => request.status === 'pending'
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
      ...(taskRecipients.length ? { taskRecipients } : {}),
      ...(input.via ? { via: input.via } : {}),
      reason,
      requestedBy: input.requestedBy,
      status: 'pending',
      createdAt: Date.now(),
    };
    (await this.save(request));
    (await this.store.appendAudit({
      principalId: input.requestedBy,
      action: 'permission.requested',
      scopeKey: `project:${input.projectId}`,
      detail: { requestId: request.id, taskId: input.taskId, role: input.role, capabilities, projectIds, baseAuthorization: input.baseAuthorization, audience, recipients, avatarRecipients, taskRecipients },
    }));
    return request;

    });
  }

  async resolve(requestId: string, input: { action: 'approve' | 'deny'; by: string; alreadyAuthorized?: boolean; claim?: string }): Promise<PermissionRequest> {
    return this.store.transaction(async () => {
    const request = (await this.lockedRequest(requestId));
    if (!request) throw new Error(`no permission request ${requestId}`);
    if (request.status !== 'pending') throw new ConflictError(`request ${requestId} is already ${request.status}`);
    (await this.assertUnclaimed(requestId, input.claim));
    if (input.action === 'approve' && !input.alreadyAuthorized) (await this.extend(request.taskId, request.role, request.capabilities));
    request.status = input.action === 'approve' ? 'granted' : 'denied';
    request.resolution = { action: input.action, by: input.by, at: Date.now() };
    (await this.save(request));
    (await this.store.kvDelete(claimKey(requestId)));
    (await this.store.appendAudit({
      principalId: input.by,
      action: 'permission.request.resolved',
      scopeKey: `project:${request.projectId}`,
      detail: { requestId, taskId: request.taskId, role: request.role, capabilities: request.capabilities, projectIds: request.projectIds, action: input.action },
    }));
    return request;

    });
  }

  /** Address a sub-task's request to the people (and Avatārs) its parent
   * named, with its note (sub-task-asks.ts). The parent stays a recipient: it
   * may still decline it, or grant it once it holds it itself. */
  async passOn(id: string, input: { audience: string[]; recipients: string[]; avatarRecipients: string[]; via: Via }): Promise<PermissionRequest> {
    return this.store.transaction(async () => {
      const request = (await this.lockedRequest(id));
      if (!request) throw new Error(`no permission request ${id}`);
      if (request.status !== 'pending') throw new ConflictError(`request ${id} is already ${request.status}`);
      if (!input.recipients.length && !input.avatarRecipients.length) throw new Error('choose at least one person, team, or Avatar');
      request.audience = [...new Set([...request.audience, ...input.audience])];
      request.recipients = [...new Set(input.recipients)];
      request.avatarRecipients = [...new Set(input.avatarRecipients)];
      request.via = input.via;
      delete request.dismissed;
      (await this.save(request));
      (await this.store.appendAudit({ principalId: `task:${input.via.taskId}`, action: 'permission.request.passed-on',
        scopeKey: `project:${request.projectId}`, detail: { requestId: id, audience: input.audience, recipients: request.recipients } }));
      return request;
    });
  }

  async dismiss(id: string, by: string, claim?: string): Promise<PermissionRequest> {
    return this.store.transaction(async () => {
    const request = (await this.lockedRequest(id));
    if (!request) throw new Error(`no permission request ${id}`);
    if (request.status !== 'pending') throw new ConflictError(`request ${id} is already ${request.status}`);
    (await this.assertUnclaimed(id, claim));
    request.dismissed ??= { by, at: Date.now() };
    (await this.save(request));
    (await this.store.appendAudit({ principalId: by, action: 'permission.request.dismissed',
      scopeKey: `project:${request.projectId}`, detail: { requestId: id } }));
    return request;

    });
  }

  /** Take back a request nobody needs to decide any more: its task's agent
   * asked for it and no longer wants it. One already decided is returned as
   * it is; one being decided right now is refused. */
  async withdraw(id: string, by: string, reason: string): Promise<PermissionRequest> {
    return this.store.transaction(async () => {
      const request = (await this.lockedRequest(id));
      if (!request) throw new Error(`no permission request ${id}`);
      if (request.status !== 'pending') return request;
      (await this.assertUnclaimed(id));
      (await this.markWithdrawn(request, by, reason));
      return request;
    });
  }

  /** Withdraw every pending request of a task that has settled: a decision
   * could no longer reach its agent. Returns the requests it withdrew. */
  async withdrawForTask(taskId: string, reason: string): Promise<PermissionRequest[]> {
    return this.store.transaction(async () => {
      (await this.lockTaskRequests(taskId));
      const withdrawn: PermissionRequest[] = [];
      for (const request of (await this.requests({ taskId, status: 'pending' }))) {
        (await this.markWithdrawn(request, 'system:task-settled', reason));
        withdrawn.push(request);
      }
      return withdrawn;
    });
  }

  private async markWithdrawn(request: PermissionRequest, by: string, reason: string): Promise<void> {
    request.status = 'withdrawn';
    request.withdrawn = { by, at: Date.now(), reason };
    (await this.save(request));
    (await this.store.kvDelete(claimKey(request.id)));
    (await this.store.appendAudit({ principalId: by, action: 'permission.request.withdrawn',
      scopeKey: `project:${request.projectId}`, detail: { requestId: request.id, taskId: request.taskId, reason } }));
  }

  /** Drop a request outright, with any decision claim on it. */
  async remove(request: Pick<PermissionRequest, 'taskId' | 'id'>): Promise<void> {
    return this.store.transaction(async () => {
      (await this.store.kvDelete(requestKey(this.organizationId, request)));
      (await this.store.kvDelete(claimKey(request.id)));
    });
  }

  private async save(request: PermissionRequest): Promise<void> {
    (await this.store.kvSet(requestKey(this.organizationId, request), JSON.stringify(request)));
  }
}
