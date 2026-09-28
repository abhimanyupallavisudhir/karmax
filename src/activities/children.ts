import type { Store } from '../store/db.js';

/** Detached children outlive a lifecycle replacement of their parent. */
export function makeChildActivities(store: Store) {
  return {
    async restoreChildTasks(parentTaskId: string) {
      const children = await store.childTasks(parentTaskId);
      return children.filter((child) => child.lastView?.state?.lifecycleReplacement
        || !['done', 'cancelled', 'failed'].includes(child.lastView?.status ?? ''))
        .map((child) => ({ taskId: child.id, title: child.title,
          waiting: child.lastView?.waitingFor?.kind === 'parent',
          detail: child.lastView?.waitingFor?.detail }));
    },
    /** Which of these children's durable views have settled, and at what stage. */
    async settledChildTasks(parentTaskId: string, childTaskIds: string[]) {
      return (await store.childTaskStates(parentTaskId, childTaskIds))
        .filter((child) => !child.lifecycleReplacement && ['done', 'cancelled', 'failed'].includes(child.status ?? ''))
        .map((child) => ({ taskId: child.id, stage: child.stage ?? child.status! }));
    },
  };
}
export type childActivities = ReturnType<typeof makeChildActivities>;
