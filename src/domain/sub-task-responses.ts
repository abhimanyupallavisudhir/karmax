import type { SubTaskAction } from './types.js';

/**
 * The answers a sub-task waiting for its parent can act on now. Any other
 * answer only set a flag nothing read: the child kept waiting, and the parent,
 * having answered, stopped waiting for it, so both stood still for good. With
 * the child not waiting for its parent, an answer waits for its next stop and
 * every one is accepted (undefined).
 */
export function applicableSubTaskActions(view: {
  stage: string; status: string; waitingFor?: { kind: string }; actions?: Array<{ name: string }>;
}): SubTaskAction[] | undefined {
  if (view.waitingFor?.kind !== 'parent') return undefined;
  const offered = new Set((view.actions ?? []).map((action) => action.name));
  if (view.stage === 'escalated' || view.status === 'blocked') return ['retry', 'comment', 'cancel',
    ...(offered.has('confirm') ? ['confirm' as const] : []), ...(offered.has('openPr') ? ['open_pr' as const] : []),
    ...(offered.has('keepOwnResources') ? ['keep_own' as const] : [])];
  if (view.stage === 'review') return ['confirm', 'comment', 'cancel'];
  if (view.stage === 'do') return ['open_pr', 'confirm', 'comment', 'cancel'];
  return undefined;
}
