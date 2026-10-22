import type { Store } from '../store/db.js';
import { PermissionRequests } from './permission-requests.js';
import { AuthorizationRequests } from './authorization-requests.js';
import { VaultItems } from '../autonomy/vault-items.js';
import { CONNECTION_PREFIX, OPEN_CONNECTION, ignoreTaskConnectionRequests } from '../integrations/connection-requests.js';
import { tasksWithPendingRepositoryAccess, withdrawRepositoryAccessRequests } from '../integrations/repository-access.js';

/** Who ignored a request whose task settled. */
export const TASK_SETTLED = 'system:task-settled';

/**
 * Statuses after which a task's requests stop asking (PL-10). Not `failed`:
 * reconcile fails every task a crash stopped, and recovery resumes them still
 * waiting on their requests.
 */
export const SETTLES_REQUESTS = new Set<string>(['done', 'cancelled']);

/**
 * A task that is done or cancelled asks nobody anything any more: no decision
 * could reach it. Its permission requests are withdrawn; its credential,
 * authorization and app-connection requests are ignored, as a person's Ignore
 * would, so they stay answerable but notify nobody. Each change is announced
 * with the event that discharges its inbox rows.
 */
export async function settleTaskRequests(store: Store, organizationId: string, taskId: string, status: string): Promise<void> {
  const reason = `task ${status}`;
  for (const request of (await new PermissionRequests(store, organizationId).withdrawForTask(taskId, reason)))
    (await store.appendEvent({ taskId, type: 'permission.approval-resolved', ts: Date.now(),
      payload: { requestId: request.id, action: 'withdraw', reason } }));
  for (const request of (await withdrawRepositoryAccessRequests(store, organizationId, taskId)))
    (await store.appendEvent({ taskId, type: 'repository-access.approval-resolved', ts: Date.now(),
      payload: { requestId: request.id, action: 'withdraw', reason } }));
  for (const request of (await new VaultItems(store, undefined, undefined, organizationId).ignoreTaskRequests(taskId, TASK_SETTLED)))
    (await store.appendEvent({ taskId, type: 'credential.approval-dismissed', ts: Date.now(), payload: { requestId: request.id } }));
  for (const request of (await new AuthorizationRequests(store, organizationId).ignoreTaskRequests(taskId, TASK_SETTLED))) {
    (await store.removeAuthorizationInbox(request.id));
    (await store.appendEvent({ taskId, type: 'authorization.approval-dismissed', ts: Date.now(), payload: { requestId: request.id } }));
  }
  (await ignoreTaskConnectionRequests(store, taskId, TASK_SETTLED));
}

/** Every task with a request still asking someone, of any kind. */
export async function tasksWithOpenRequests(store: Store): Promise<Set<string>> {
  const tasks = new Set<string>();
  const organizations = new Set(['org_personal', ...(await store.listOrganizations()).map((organization) => organization.id)]);
  for (const organizationId of organizations) {
    for (const request of (await new PermissionRequests(store, organizationId).requests({ status: 'pending' }))) tasks.add(request.taskId);
    for (const request of (await new VaultItems(store, undefined, undefined, organizationId).requests({ status: 'pending' })))
      if (!request.dismissed) tasks.add(request.taskId);
    for (const request of (await new AuthorizationRequests(store, organizationId).requests({ status: 'pending' })))
      if (!request.dismissed && request.target.kind === 'task') tasks.add(request.target.taskId);
    for (const taskId of (await tasksWithPendingRepositoryAccess(store, organizationId))) tasks.add(taskId);
  }
  for (const { value } of (await store.kvEntries(CONNECTION_PREFIX))) {
    try {
      const c = JSON.parse(value);
      if (OPEN_CONNECTION.includes(c.status) && !c.dismissed && c.taskId) tasks.add(c.taskId);
    } catch { /* an unreadable record is left alone */ }
  }
  return tasks;
}
