/**
 * Who is told when automatic recovery gives up (software-dev ≥1.27).
 *
 * A failure is routed to whoever can fix its cause: project settings
 * (repository access, environment, GitHub App permissions) to the project's
 * maintainers; organization settings (logins, keys, billing) to its
 * administrators; infrastructure that stayed down through every retry to the
 * creator and administrators; anything else — the task's own work — to whoever
 * the task answers to (its parent for a sub-task, otherwise its creator).
 * Pure: shared by the workflow sandbox, the gateway and tests.
 */
export type FailureCause = 'task' | 'project' | 'organization' | 'infrastructure';

export function failureAudience(cause: FailureCause): string[] {
  switch (cause) {
    case 'project': return ['@maintainers'];
    case 'organization': return ['@admins'];
    case 'infrastructure': return ['@creator', '@admins'];
    default: return ['@creator'];
  }
}

/** What a failure's typed classification says about its cause. */
export function failureCause(input: { types?: string[]; stage?: string; credentialDenied?: boolean; hardLimit?: boolean; infrastructure?: boolean }): FailureCause {
  const types = new Set(input.types ?? []);
  if (input.infrastructure) return 'infrastructure';
  if (input.credentialDenied || input.hardLimit) return 'organization';
  if (types.has('github-workflows-permission') || types.has('repository-access') || types.has('environment-install'))
    return 'project';
  if (input.stage === 'setup') return 'project';
  return 'task';
}

/** How a stage's escalation begins when its provider account's limit stayed
 * full through its whole wait for a machine (software-dev withResolve,
 * failures.ts CAPACITY_WAIT_LIMIT_MS). Only the account's other machines
 * stopping, a smaller Computer or a higher limit frees it: people's to choose,
 * never a defect of tavya's, so it is not reported as an error
 * (activities/core.ts reportEscalation). */
export const NO_MACHINE_FOR_A_DAY = 'No machine for a day';

export function isCapacityEscalation(error: string | undefined): boolean {
  return typeof error === 'string' && error.startsWith(NO_MACHINE_FOR_A_DAY);
}

/** How a task's human delegation that lapsed on its own says so
 * (platform/tokens.ts HumanDelegationLapsed): it expired, or it was purged
 * long enough ago that how is not known. The person it acts for renews it by
 * acting on the task: theirs to do, not a defect of tavya's, so it is not
 * reported as an error. One "withdrawn" (a revoked row) is still reported:
 * nothing tavya does should withdraw a live task's (wiki incidents/lessons,
 * 8209137dc12067d1). */
export const DELEGATION_LAPSED_OF_ITS_OWN = /permission to act for the person who authorized it (?:expired on \d{4}-\d{2}-\d{2}|has lapsed)\b/;

export function isDelegationLapseOfItsOwn(error: string | undefined): boolean {
  return typeof error === 'string' && DELEGATION_LAPSED_OF_ITS_OWN.test(error);
}
