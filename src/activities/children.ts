import type { Store } from '../store/db.js';
import { pullRequestOf } from '../domain/pull-requests.js';

const SETTLED = ['done', 'cancelled', 'failed'];

/** One of a task's own pull requests (v1.30), as its record says it is: what a
 * replacement run rebuilds when its checkpoint lost it (pramana#102). */
export interface RestoredPullRequest {
  checkout: string;
  branch: string;
  /** The commit it is a snapshot of, from its latest `pull-request.snapshot`. */
  head?: string;
  target?: string;
  /** Its record's status: `done`, `cancelled` or `failed` once it settled. */
  status: string;
}

/** Detached children outlive a lifecycle replacement of their parent. */
export function makeChildActivities(store: Store) {
  return {
    async restoreChildTasks(parentTaskId: string) {
      // A draft never ran: nothing waits on it until it is queued.
      const children = (await store.childTasks(parentTaskId)).filter((child) => !child.params?.draft);
      const settled = (child: (typeof children)[number]) => !child.lastView?.state?.lifecycleReplacement
        && SETTLED.includes(child.lastView?.status ?? '');
      const pullRequests = children.filter((child) => pullRequestOf(child));
      const heads = new Map<string, string>();
      if (pullRequests.length)
        for (const event of await store.eventsOfType(parentTaskId, 'pull-request.snapshot')) {
          const { childTaskId, head } = event.payload as { childTaskId?: unknown; head?: unknown };
          if (typeof childTaskId === 'string' && typeof head === 'string') heads.set(childTaskId, head);
        }
      // A settled sub-task needs nothing more; a settled pull request is still
      // the task's own (what landed is not proposed again).
      return children.filter((child) => !settled(child) || pullRequestOf(child)).map((child) => {
        const of = pullRequestOf(child);
        const pullRequest: RestoredPullRequest | undefined = of && {
          checkout: of.checkout, branch: child.lastView?.branch ?? `tavya/${child.id}`,
          ...(heads.has(child.id) ? { head: heads.get(child.id) } : {}),
          ...(child.lastView?.targetBranch ? { target: child.lastView.targetBranch } : {}),
          status: settled(child) ? child.lastView!.status : 'open',
        };
        return { taskId: child.id, title: child.title,
          waiting: child.lastView?.waitingFor?.kind === 'parent',
          detail: child.lastView?.waitingFor?.detail,
          ...(pullRequest ? { pullRequest } : {}) };
      });
    },
    /** Which of these children's durable views have settled, and at what stage. */
    async settledChildTasks(parentTaskId: string, childTaskIds: string[]) {
      return (await store.childTaskStates(parentTaskId, childTaskIds))
        .filter((child) => !child.lifecycleReplacement && SETTLED.includes(child.status ?? ''))
        .map((child) => ({ taskId: child.id, stage: child.stage ?? child.status! }));
    },
  };
}
export type childActivities = ReturnType<typeof makeChildActivities>;
