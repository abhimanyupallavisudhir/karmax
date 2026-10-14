import type { Store } from '../store/db.js';

/** Journal the same human decision for direct and deferred Review confirmation. */
export async function recordHumanConfirmation(store: Store, taskId: string, userId: string): Promise<void> {
  const task = (await store.getTask(taskId));
  if (!task?.lastView || task.lastView.waitingFor?.kind !== 'human') return;
  // A failed Confirm agent can expose the same human decision from its
  // escalation frame. Preserve that person's GitHub authorization too.
  const reviewConfirmation = task.lastView.stage === 'review'
    || (task.lastView.stage === 'escalated'
      && task.lastView.actions.some((action) => action.name === 'confirm' && action.enabled));
  (await store.appendEvent({ taskId, type: 'task.confirmation-voted', ts: Date.now(),
    payload: {
      userId, audience: task.lastView.waitingFor.audience ?? ['@creator'], satisfied: true,
      githubMergeAuthorized: Boolean(task.lastView.prs?.length
        && (reviewConfirmation || task.lastView.stage === 'merge')),
      // Current software-dev treats a Review confirmation as durable
      // authorization of the task intent, including bounded automated
      // integration repairs. An exceptional Landing confirmation still
      // records the exact current heads below for strict GitHub policy.
      githubMergeIntentAuthorized: Boolean(task.lastView.prs?.length
        && Number(String(task.workflowVersion ?? '').split('.')[1] ?? 0) >= 16
        && reviewConfirmation),
      githubPrHeads: (task.lastView.prs ?? []).map((ref) => ({
        slug: ref.slug, number: ref.number, headSha: ref.headSha,
      })),
    } }));
}

/** Software-dev ≥1.30: a person approved proposed branches of a multi-PR task.
 * Their Review no longer parks the task, so the vote is journaled from the
 * branches themselves: it authorizes the intent of exactly their pull requests,
 * which is whose GitHub authorization lands them. */
export async function recordBranchApproval(store: Store, taskId: string, userId: string, names: string[]): Promise<void> {
  const task = (await store.getTask(taskId));
  const branches = (task?.lastView?.checkouts ?? []).filter((checkout) => names.includes(checkout.name) && checkout.state === 'review');
  if (!branches.length) return;
  const prs = branches.flatMap((checkout) => checkout.pr ? [checkout.pr] : []);
  (await store.appendEvent({ taskId, type: 'task.confirmation-voted', ts: Date.now(),
    payload: {
      userId, audience: task?.lastView?.reviewAudience ?? ['@creator'], satisfied: true, branches: branches.map((checkout) => checkout.name),
      githubMergeAuthorized: prs.length > 0, githubMergeIntentAuthorized: prs.length > 0,
      githubPrHeads: prs.map((ref) => ({ slug: ref.slug, number: ref.number, headSha: ref.headSha })),
    } }));
}
