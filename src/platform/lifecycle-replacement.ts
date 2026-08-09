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
