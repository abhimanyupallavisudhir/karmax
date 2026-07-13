import type { FieldMutable } from '../domain/types.js';

/**
 * In-flight param editability (SPEC §4.5/§5.5). This module is intentionally
 * PURE and import-free at runtime (only a type import, which is erased), so the
 * deterministic Temporal workflow sandbox and the gateway can share exactly one
 * predicate — the workflow enforces it as an update validator, the gateway/UI
 * reads `TaskView.editableParams` derived from it.
 *
 * A param declared `untilUsed` is editable until the workflow *consumes* it. The
 * per-param consumption point is workflow-specific (target → PR/merge enqueue;
 * an auxiliary agent → that role's turn), so the workflow decides `consumed`
 * for each field and this predicate just applies the window uniformly.
 */
export interface MutabilityFlags {
  /** Has the workflow already consumed THIS param (its value is now load-bearing)? */
  consumed: boolean;
  /** The merge commit landed — the point of no return; nothing is editable after. */
  pointOfNoReturnPassed: boolean;
}

/** Whether a param with the given window may be edited right now. `undefined` ⇒ `queue`. */
export function editableInFlight(window: FieldMutable | undefined, flags: MutabilityFlags): boolean {
  if (flags.pointOfNoReturnPassed) return false;
  switch (window ?? 'queue') {
    case 'always':
      return true;
    case 'untilUsed':
      return !flags.consumed;
    default:
      return false; // 'queue'
  }
}

/**
 * The names of the currently-editable in-flight params, given each param's
 * declared window and a per-name `isConsumed` predicate. Drives
 * `TaskView.editableParams`.
 */
export function editableParamNames(
  paramWindows: Record<string, FieldMutable> | undefined,
  isConsumed: (name: string) => boolean,
  pointOfNoReturnPassed: boolean,
): string[] {
  return Object.keys(paramWindows ?? {}).filter((n) =>
    editableInFlight(paramWindows![n], { consumed: isConsumed(n), pointOfNoReturnPassed }),
  );
}
