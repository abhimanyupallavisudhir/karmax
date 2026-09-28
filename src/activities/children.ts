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
    /** Children whose durable view has settled, with the stage they ended in. */
    async settledChildTasks(parentTaskId: string) {
      const children = await store.childTasks(parentTaskId);
      return children.filter((child) => !child.lastView?.state?.lifecycleReplacement
        && ['done', 'cancelled', 'failed'].includes(child.lastView?.status ?? ''))
        .map((child) => ({ taskId: child.id, stage: child.lastView!.stage }));
    },
  };
}
export type childActivities = ReturnType<typeof makeChildActivities>;
