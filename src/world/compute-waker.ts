import type { Store } from '../store/db.js';
import { accountRoom, type Account } from './account-room.js';
import { dequeue, noteSignalled, ordered, waiters, type AccountKey } from './compute-queue.js';

/**
 * The compute queue's waker (wiki features/managed-compute § Queue): a task
 * waiting for room tries again on its own only every 30 s to 5 min, so the
 * room another task frees would sit idle, or go to whichever task happened
 * to try first. Every few seconds this asks the first task in each account's
 * queue that now fits to try again at once (the workflow's Retry). Where the
 * account's budget is unknown (the provider refuses only when asked), the
 * first one is asked every couple of minutes, which no task behind it can
 * pass. Waiters whose task ended leave the queue.
 */
export const WAKE_EVERY_MS = 15_000;
/** A task told to try again is not told again sooner than this. */
export const SIGNAL_GAP_MS = 30_000;
/** Where nothing tells whether there is room, the first in line is asked this often. */
export const BLIND_SIGNAL_GAP_MS = 2 * 60_000;

export interface WakerDeps {
  store: Store;
  /** The account behind a queue key, with its budget; undefined when it is gone. */
  account(key: AccountKey): Promise<Account | undefined>;
  /** Ask a task waiting for a machine to try again now; false when it is not waiting for one. */
  retry(taskId: string): Promise<boolean>;
  now?: number;
}

const ENDED = new Set(['done', 'cancelled', 'failed']);

export async function wakeComputeQueue(deps: WakerDeps): Promise<string[]> {
  const { store } = deps;
  const now = deps.now ?? Date.now();
  let all = await waiters(store, now);
  for (const waiter of all) {
    const status = (await store.getTask(waiter.taskId))?.lastView?.status;
    if (status === undefined || ENDED.has(status)) await dequeue(store, waiter.taskId, now);
  }
  all = await waiters(store, now);
  const told: string[] = [];
  for (const key of new Set(all.flatMap((waiter) => Object.keys(waiter.accounts)))) {
    const account = await deps.account(key);
    if (!account) continue;
    const known = Boolean(account.pool?.cpu || account.pool?.machines || account.pool?.diskGb);
    for (const waiter of ordered(all, key)) {
      if (told.includes(waiter.taskId)) break;
      if (waiter.signalled && now - waiter.signalled < (known ? SIGNAL_GAP_MS : BLIND_SIGNAL_GAP_MS)) {
        if (known) continue; else break;
      }
      // Would it be let in now? (Admission also passes over one ahead that
      // does not fit the free room, so a later one may go first.)
      const refusal = await accountRoom(store, account, { organizationId: waiter.organizationId, taskId: waiter.taskId,
        ...(waiter.cpu !== undefined ? { cpu: waiter.cpu } : {}), ...(waiter.diskGb !== undefined ? { diskGb: waiter.diskGb } : {}), peek: true }, now);
      if (refusal) { if (known) continue; else break; }
      if (await deps.retry(waiter.taskId).catch(() => false)) {
        await noteSignalled(store, waiter.taskId, now);
        told.push(waiter.taskId);
      }
      break;
    }
  }
  return told;
}
