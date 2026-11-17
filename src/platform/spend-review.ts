import type { TaskView } from '../domain/types.js';

const WAITING = new Set(['pending_approval', 'needs_funding']);

/**
 * A spend's Approve/Deny buttons (and its funding link) are asked once: from
 * the moment its request is decided they are marked `resolved`, whatever the
 * workflow's copy of the review info still says, so no page offers them again
 * (#960: approved twice). They stay in the list so action indices never shift.
 */
export async function withSpendResolutions(
  store: { getPaymentSpendRequest(id: string): Promise<{ taskId?: string; status?: string } | undefined> },
  taskId: string, view: TaskView,
): Promise<TaskView> {
  const actions = view.reviewInfo?.actions;
  const ids = [...new Set((actions ?? []).map((action) => action.requestId).filter((id): id is string => !!id))];
  if (!actions || !ids.length) return view;
  const resolved = new Map<string, 'approved' | 'denied'>();
  for (const id of ids) {
    const request = await store.getPaymentSpendRequest(id);
    if (!request || request.taskId !== taskId || WAITING.has(String(request.status))) continue;
    resolved.set(id, request.status === 'denied' ? 'denied' : 'approved');
  }
  if (!resolved.size) return view;
  return { ...view, reviewInfo: { ...view.reviewInfo, actions: actions.map((action) => {
    const outcome = action.requestId ? resolved.get(action.requestId) : undefined;
    return outcome ? { ...action, resolved: outcome } : action;
  }) } };
}
