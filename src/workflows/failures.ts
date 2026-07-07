import { ActivityFailure, ApplicationFailure, TimeoutFailure } from '@temporalio/workflow';

/**
 * Turn-failure taxonomy (SPEC §5.2). `runAgentTurn` tags what it throws so the
 * retry policy and the workflows can route each failure to the machinery that
 * can actually fix it:
 *
 *   'agent-infra'  transport/stream death — retryable; Temporal re-runs the
 *                  turn, and the next attempt resumes the interrupted session
 *                  from heartbeat details (a "continue", not a re-run)
 *   'agent-limit'  usage/session/billing limit — non-retryable; the workflow's
 *                  account leasing rotates to the next credential
 *   'agent-error'  everything else — non-retryable; the Resolve path
 *
 * Temporal-generated timeouts count as infrastructure too: a heartbeat gap
 * means the worker/host died or slept (2026-07-07: a closed laptop lid ate a
 * turn and the failure was escalated to a Resolve agent that could do nothing
 * about it), and start-to-close means the wall clock ran out under the turn.
 */
export function isInfraFailure(err: unknown): boolean {
  if (!(err instanceof ActivityFailure)) return false;
  const cause = err.cause;
  if (cause instanceof TimeoutFailure) return true;
  return cause instanceof ApplicationFailure && cause.type === 'agent-infra';
}

/**
 * Park-and-retry schedule for infra failures that outlived the activity-level
 * retries (i.e. the outage lasted minutes, not seconds). No agent can fix
 * infrastructure, so the workflows wait these out instead of running Resolve,
 * then escalate to a human once the schedule is exhausted.
 */
export const INFRA_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000] as const;
