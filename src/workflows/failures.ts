import { ActivityFailure, ApplicationFailure, TimeoutFailure } from '@temporalio/workflow';
import { classifyLimitError, type LimitClassification, type ProviderFailureMetadata } from '../agent/limits.js';

/**
 * Turn-failure taxonomy (SPEC §5.2). `runAgentTurn` tags what it throws so the
 * retry policy and the workflows can route each failure to the machinery that
 * can actually fix it:
 *
 *   'agent-infra'  transport/stream death — retryable; Temporal re-runs the
 *                  turn, and the next attempt resumes the interrupted session
 *                  from heartbeat details (a "continue", not a re-run)
 *   'agent-limit'  usage/session/billing limit — non-retryable; typed metadata in
 *                  details tells account leasing whether to rotate/park/escalate
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

/** Recover provider-ground-truth limit metadata serialized by runAgentTurn. Old
 * histories have no details, so the `agent-limit` type remains authoritative and
 * their message is parsed only to recover hard/reset hints. */
export function limitFailureClassification(err: unknown): LimitClassification | undefined {
  if (!(err instanceof ActivityFailure)) return undefined;
  const cause = err.cause;
  if (!(cause instanceof ApplicationFailure) || cause.type !== 'agent-limit') return undefined;
  const detail = cause.details?.[0] as ProviderFailureMetadata | undefined;
  if (detail?.kind && (detail.permanence === 'hard' || detail.permanence === 'transient')) {
    return {
      limited: true,
      hard: detail.permanence === 'hard' || undefined,
      kind: detail.kind,
      window: detail.window,
      resetHint: detail.resetHint,
      note: detail.note,
    };
  }
  const legacy = classifyLimitError(cause.message ?? '', { providerOrigin: true });
  return legacy.limited ? legacy : { limited: true, kind: 'quota', window: '5h' };
}

/**
 * Park-and-retry schedule for infra failures that outlived the activity-level
 * retries (i.e. the outage lasted minutes, not seconds). No agent can fix
 * infrastructure, so the workflows wait these out instead of running Resolve,
 * then escalate to a human once the schedule is exhausted.
 */
export const INFRA_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000] as const;
