/**
 * Pure name constants for coordinators. Activity (Node) code references these
 * by string to signal/start coordinator workflows WITHOUT importing the
 * workflow modules (which run `proxyActivities` at import time and would throw
 * outside the deterministic sandbox).
 */
export const MERGE_QUEUE_WORKFLOW = 'mergeQueue';
export const ACCOUNT_COORDINATOR_WORKFLOW = 'accountCoordinator';
export const BUDGET_COORDINATOR_WORKFLOW = 'budgetCoordinator';

export const SIG_ENQUEUE = 'enqueue';
export const SIG_RELEASE = 'release';
export const SIG_PRIORITIZE = 'prioritize';
export const SIG_CANCEL_MERGE = 'cancelMerge';
export const SIG_MERGE_GRANTED = 'mergeGranted';
export const QRY_QUEUE = 'queue';

export const SIG_LEASE_ACCOUNT = 'leaseAccount';
export const SIG_RETURN_ACCOUNT = 'returnAccount';
export const SIG_ACCOUNT_GRANTED = 'accountGranted';
export const SIG_REGISTER_ACCOUNTS = 'registerAccounts';
/** Ground-truth exhaustion feed from auto-resolve: mark a login unavailable +
 *  arm a refresh timer (SPEC §6.2). */
export const SIG_REPORT_EXHAUSTED = 'reportExhausted';
/** Manual override (UI/MCP): set a login available/unavailable + its reset time. */
export const SIG_SET_ACCOUNT_AVAILABILITY = 'setAccountAvailability';
export const QRY_ACCOUNTS = 'accounts';

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
