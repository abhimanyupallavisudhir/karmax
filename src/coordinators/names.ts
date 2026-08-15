/**
 * Pure name constants for coordinators. Activity (Node) code references these
 * by string to signal/start coordinator workflows WITHOUT importing the
 * workflow modules (which run `proxyActivities` at import time and would throw
 * outside the deterministic sandbox).
 */
export const MERGE_QUEUE_WORKFLOW = 'mergeQueue';
export const AGENT_QUEUE_WORKFLOW = 'agentQueue';
export const ACCOUNT_COORDINATOR_WORKFLOW = 'accountCoordinator';
export const BUDGET_COORDINATOR_WORKFLOW = 'budgetCoordinator';
export const RESOURCE_PUBLISH_COORDINATOR_WORKFLOW = 'resourcePublishCoordinator';

export const SIG_ENQUEUE = 'enqueue';
export const SIG_RELEASE = 'release';
export const SIG_PRIORITIZE = 'prioritize';
/** Generic queue reorder (drag / move-to-bottom): move a task before another,
 *  or to the end when no anchor is given. Move-to-top stays SIG_PRIORITIZE. */
export const SIG_REORDER = 'reorderQueue';
export const SIG_CANCEL_MERGE = 'cancelMerge';
export const SIG_MERGE_GRANTED = 'mergeGranted';
export const QRY_QUEUE = 'queue';

export const SIG_LEASE_AGENT = 'leaseAgentSlot';
export const SIG_REQUEST_AGENT = 'requestAgentSlotV2';
export const SIG_AGENT_SLOT_GRANTED = 'agentSlotGranted';
export const SIG_CANCEL_AGENT = 'cancelAgentSlot';
export const SIG_RELEASE_AGENT = 'releaseAgentSlot';
export const SIG_SET_AGENT_CAPACITY = 'setAgentCapacity';
export const UPD_WAIT_AGENT = 'waitAgentSlot';
export const UPD_REQUEST_AGENT = 'requestAgentSlotV2';
export const QRY_AGENT_QUEUE = 'agentQueue';

export const SIG_ENQUEUE_RESOURCE_PUBLISH = 'enqueueResourcePublish';
export const SIG_RELEASE_RESOURCE_PUBLISH = 'releaseResourcePublish';
export const SIG_CANCEL_RESOURCE_PUBLISH = 'cancelResourcePublish';
export const QRY_RESOURCE_PUBLISH = 'resourcePublishQueue';

export const SIG_LEASE_ACCOUNT = 'leaseAccount';
export const SIG_CANCEL_ACCOUNT = 'cancelAccountLease';
export const SIG_RETURN_ACCOUNT = 'returnAccount';
export const SIG_ACCOUNT_GRANTED = 'accountGranted';
export const SIG_REGISTER_ACCOUNTS = 'registerAccounts';
/** Ground-truth exhaustion feed from auto-resolve: mark a login unavailable +
 *  arm a refresh timer (SPEC §6.2). */
export const SIG_REPORT_EXHAUSTED = 'reportExhausted';
/** Manual override (UI/MCP): set a login available/unavailable + its reset time. */
export const SIG_SET_ACCOUNT_AVAILABILITY = 'setAccountAvailability';
/** Synchronous update variants used by activities that must not re-lease a stale
 * account before the coordinator has applied its new availability state. */
export const UPD_REPORT_EXHAUSTED = 'reportExhaustedSync';
export const UPD_SET_ACCOUNT_AVAILABILITY = 'setAccountAvailabilitySync';
export const QRY_ACCOUNTS = 'accounts';
/** Acknowledges whether one exact lease request is still parked after enqueue. */
export const QRY_ACCOUNT_LEASE = 'accountLease';
/** Finds every parked credential request owned by a task for out-of-band stop/drain. */
export const QRY_ACCOUNT_TASK_LEASES = 'accountTaskLeases';

export const SIG_REQUEST_SPEND = 'requestSpend';
export const SIG_APPROVE_SPEND = 'approveSpend';
export const SIG_DENY_SPEND = 'denySpend';
export const SIG_SPEND_RESULT = 'spendResult';
export const QRY_BUDGET = 'budget';

export function mergeQueueId(domain: string): string {
  return `merge-queue:${domain}`;
}

export function accountCoordinatorId(): string {
  return 'account-coordinator';
}

export function agentQueueId(organizationId?: string): string {
  return organizationId ? `agent-queue:${organizationId}` : 'agent-queue';
}

export function resourcePublishCoordinatorId(attachmentId: string): string {
  return `resource-publish:${attachmentId}`;
}

/** A login's `maxConcurrent` when the user chooses "unlimited" (empty field in the UI).
 *  Large enough to never bind; kept finite so coordinator state stays plain-serializable. */
export const UNLIMITED_CONCURRENCY = 1_000_000;
