/**
 * The bounded recovery vocabulary (RESOLVE-PLAN §1). auto-resolve (script), the
 * Resolve agent (a structured `resolve_decision` tool call), and the human
 * (escalation UI) all express the SAME small set of transitions; one deterministic
 * workflow-side executor applies them. Pure types — importable by the workflow
 * sandbox, the gateway, and the UI. We deliberately do NOT accept free-form JSON
 * actions (SPEC §0 "declare, don't guess"): every transition is typed + validated.
 */
import type { Stage } from '../domain/types.js';

/** What a parked task is waiting on before its `then` action fires. */
export type WaitEvent =
  | { kind: 'account'; provider?: string; earliestResetAt?: number }
  | { kind: 'mergeSlot'; domain?: string }
  | { kind: 'human' }
  | { kind: 'subtask'; taskId?: string };

/** The bounded action taken once a park's awaited condition is met. */
export type ThenAction =
  | { do: 'resume' }
  | { do: 'retryStage' }
  | { do: 'gotoStage'; stage: Stage; params?: Record<string, unknown> };

/** A recovery transition. Applied only at a safe await/park boundary (never
 *  mid-activity); never crosses the point of no return. */
export type Transition =
  /** Continue the interrupted agent ("Continue, you got cut off") — re-run the
   *  failed stage, resuming its session. */
  | { do: 'resume' }
  /** Re-run the failed stage fresh. */
  | { do: 'retryStage' }
  /** Rewind/redirect to an earlier stage, optionally editing now-unfrozen params. */
  | { do: 'gotoStage'; stage: Stage; params?: Record<string, unknown> }
  /** Park until `event`, then take `then`. */
  | { do: 'parkUntil'; event: WaitEvent; then: ThenAction }
  /** Hand to a human now (don't burn more retries). */
  | { do: 'escalate'; reason: string };

export type TransitionKind = Transition['do'];

/** Stages a `gotoStage`/rewind may legally target (earlier, non-terminal, pre-PONR). */
export const REWINDABLE_STAGES: Stage[] = ['setup', 'do', 'review', 'pr', 'merge'];

/** Coerce a loose tool payload into a validated Transition, or null if invalid.
 *  Shared by the resolve_decision tool handler and the gateway. */
export function parseTransition(raw: unknown): Transition | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const action = o.do ?? o.action;
  switch (action) {
    case 'resume':
      return { do: 'resume' };
    case 'retryStage':
      return { do: 'retryStage' };
    case 'escalate':
      return { do: 'escalate', reason: typeof o.reason === 'string' ? o.reason : 'escalated by resolve' };
    case 'gotoStage': {
      const stage = o.stage as Stage;
      if (!REWINDABLE_STAGES.includes(stage)) return null;
      return { do: 'gotoStage', stage, ...(o.params && typeof o.params === 'object' ? { params: o.params as Record<string, unknown> } : {}) };
    }
    case 'parkUntil': {
      const event = o.event as WaitEvent;
      const then = (o.then as ThenAction) ?? { do: 'resume' };
      if (!event || typeof event !== 'object' || !('kind' in event)) return null;
      return { do: 'parkUntil', event, then };
    }
    default:
      return null;
  }
}
