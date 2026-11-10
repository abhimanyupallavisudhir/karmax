/**
 * Durable interlock between the platform request that replaces a workflow run
 * and the old run's final publish activity.
 *
 * A graceful replacement deliberately makes the old workflow return through its
 * cancellation cleanup. That cleanup is not a task cancellation, though: the
 * replacement keeps the same logical task alive. The marker lets the activity
 * boundary suppress only the old run's synthetic terminal projection while the
 * platform starts its successor.
 */
export interface LifecycleReplacementMarker {
  runId?: string;
  requestedAt: number;
}

export const lifecycleReplacementKey = (taskId: string) =>
  `task-lifecycle-replacement:${taskId}`;

export function lifecycleReplacementMatches(
  raw: string | undefined,
  runId: string | undefined,
): boolean {
  if (!raw) return false;
  try {
    const marker = JSON.parse(raw) as LifecycleReplacementMarker;
    return typeof marker.requestedAt === 'number'
      && (!marker.runId || !runId || marker.runId === runId);
  } catch {
    return false;
  }
}

/**
 * How long a replacement may take, from the marker to its successor's start:
 * the graceful stop (30 s, up to three runs), terminal cleanup, the transition
 * checkpoint and the start. A marker older than this was left by a replacement
 * that died (the platform restarted mid-way); nothing will start its successor.
 */
export const LIFECYCLE_REPLACEMENT_IN_FLIGHT_MS = 10 * 60_000;

/** Is run `runId` being replaced right now? Its close is then not the task's end. */
export function lifecycleReplacementInFlight(
  raw: string | undefined,
  runId: string | undefined,
  now = Date.now(),
): boolean {
  if (!lifecycleReplacementMatches(raw, runId)) return false;
  return now - (JSON.parse(raw!) as LifecycleReplacementMarker).requestedAt < LIFECYCLE_REPLACEMENT_IN_FLIGHT_MS;
}
