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
 *   'agent-policy' provider safety rejection — non-retryable, task-local human escalation
 *   'agent-error'  everything else — non-retryable; the Resolve path
 *   'world-infra'  cloud world create/connect transport failure — retryable;
 *                  setup uses the same outage backoff instead of Resolve
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
  return cause instanceof ApplicationFailure && (cause.type === 'agent-infra' || cause.type === 'world-infra' || cause.type === 'world-capacity');
}

/** A provider account's limit that is full ('world-capacity', also infrastructure). */
export function isCapacityFailure(err: unknown): boolean {
  return err instanceof ActivityFailure && err.cause instanceof ApplicationFailure && err.cause.type === 'world-capacity';
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
      // Diagnostic is the additive generation marker. Older histories already
      // recorded autoResolve inputs without provider; adding it during replay
      // would change a ScheduleActivity command and become nondeterministic.
      provider: detail.diagnostic ? detail.provider : undefined,
      window: detail.window,
      resetHint: detail.resetHint,
      note: detail.note,
      diagnostic: detail.diagnostic,
      // Additive like `diagnostic`: only failures recorded by this version carry it.
      ...(detail.scope === 'task' ? { taskScoped: true } : {}),
    };
  }
  const legacy = classifyLimitError(cause.message ?? '', { providerOrigin: true, legacy: true });
  return legacy.limited ? legacy : { limited: true, kind: 'quota', window: '5h' };
}

/**
 * Park-and-retry schedule for infra failures that outlived the activity-level
 * retries (i.e. the outage lasted minutes, not seconds). No agent can fix
 * infrastructure, so the workflows wait these out instead of running Resolve,
 * then escalate to a human once the schedule is exhausted.
 */
export const INFRA_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000] as const;

/**
 * How a task waits for a machine its provider cannot start right now (an
 * outage, a full account limit) when resource work needs its world: a full
 * limit frees only as other tasks' machines stop, which can take hours, so
 * the waits grow to ten minutes and go on for three hours before a person is
 * asked (pramana#79). Retry, a cancel or a stop ends a wait early.
 */
export const WORLD_WAIT_MS = [30_000, 60_000, 120_000, 300_000, 600_000] as const;
export const WORLD_WAIT_LIMIT_MS = 3 * 3_600_000;

/**
 * How a stage waits for room when its provider account's limit is full (a
 * Hetzner project's CPUs, volume space or public IPs): it tries again every
 * few minutes, as other tasks' machines stop, for a day before a person is
 * asked, instead of five waits over twenty minutes (pramana: retried by hand
 * dozens of times). Retry tries at once; a cancel ends it.
 */
export const CAPACITY_WAIT_MS = [30_000, 60_000, 120_000, 300_000] as const;
export const CAPACITY_WAIT_LIMIT_MS = 24 * 3_600_000;
