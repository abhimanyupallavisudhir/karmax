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
