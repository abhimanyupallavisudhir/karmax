import type { TaskView } from './types.js';

/**
 * Where a task stands for the people reading a task list: its stage and
 * whether it is working, waiting on a person, stalled, or finished. A change
 * of this is what moves a task to the top of a list (`statusChangedAt`).
 *
 * Waits a person has no part in read as working: an agent turn queuing for a
 * slot, an agent paused on its job, a timer or its sub-tasks, a Reviewer
 * deciding. Every turn queues for a slot and many pause on jobs, so counting
 * them put whichever task was busiest at the top (#709: 48 "changes" in a day).
 * `web/app.js` `listState` mirrors this for live updates.
 */
export function listState(view: Pick<TaskView, 'stage' | 'status' | 'waitingFor'>): string {
  return `${view.stage}|${phase(view)}`;
}

function phase(view: Pick<TaskView, 'status' | 'waitingFor'>): string {
  if (view.status === 'active') return 'working';
  if (view.status !== 'waiting') return view.status;
  const kind = view.waitingFor?.kind;
  if (kind === 'human') return 'person';
  // Nothing works until a login, quota or the infrastructure comes back.
  if (kind === 'account' || kind === 'retry') return 'stalled';
  return 'working';
}
