import {
  defineSignal,
  defineQuery,
  setHandler,
  condition,
  proxyActivities,
  continueAsNew,
  getExternalWorkflowHandle,
  workflowInfo,
  sleep,
  log,
} from '@temporalio/workflow';
import type { coordinatorActivities } from '../activities/coordinator.js';
import {
  SIG_ENQUEUE,
  SIG_RELEASE,
  SIG_PRIORITIZE,
  SIG_REORDER,
  SIG_CANCEL_MERGE,
  SIG_MERGE_GRANTED,
  QRY_QUEUE,
  mergeQueueId as mqId,
} from './names.js';

const act = proxyActivities<coordinatorActivities>({ startToCloseTimeout: '20s' });

// ─── Contract ────────────────────────────────────────────────────────────────

export interface MergeQueueState {
  domain: string;
  queue: string[];
  current?: string;
  processed: number;
}

export interface QueueView {
  domain: string;
  queue: string[];
  current?: string;
}

export const enqueueMergeSignal = defineSignal<[{ taskId: string }]>(SIG_ENQUEUE);
export const releaseMergeSignal = defineSignal<[{ taskId: string }]>(SIG_RELEASE);
export const prioritizeMergeSignal = defineSignal<[{ taskId: string }]>(SIG_PRIORITIZE);
export const reorderMergeSignal = defineSignal<[{ taskId: string; beforeTaskId?: string }]>(SIG_REORDER);
export const cancelMergeSignal = defineSignal<[{ taskId: string }]>(SIG_CANCEL_MERGE);
export const queueQuery = defineQuery<QueueView>(QRY_QUEUE);

/** The signal the coordinator sends to a task workflow to grant the merge slot. */
export const MERGE_GRANTED_SIGNAL = SIG_MERGE_GRANTED;

export const mergeQueueId = mqId;

const LEASE_TIMEOUT = '5 minutes';
const CONTINUE_AS_NEW_AFTER = 500;

/**
 * The merge-queue coordinator (SPEC §6.1). A singleton workflow per
 * serialization domain (Temporal enforces one running execution per id, so the
 * id IS the singleton). Holds the queue as explicit state and leases the single
 * merge slot. Reorder = a signal; position = a query; crash-safe via a lease
 * timeout + grantee liveness check; continue-as-new to bound history.
 */
export async function mergeQueue(input: { domain: string; state?: MergeQueueState }): Promise<void> {
  const domain = input.domain;
  let queue = input.state?.queue ?? [];
  let current = input.state?.current;
  let processed = input.state?.processed ?? 0;

  setHandler(enqueueMergeSignal, ({ taskId }) => {
    if (taskId !== current && !queue.includes(taskId)) queue.push(taskId);
  });
  setHandler(releaseMergeSignal, ({ taskId }) => {
    if (current === taskId) current = undefined;
  });
  setHandler(prioritizeMergeSignal, ({ taskId }) => {
    if (queue.includes(taskId)) queue = [taskId, ...queue.filter((t) => t !== taskId)];
  });
  // Move `taskId` to sit immediately before `beforeTaskId` (drag-and-drop); with no
  // anchor (or an anchor no longer in the queue) it falls to the bottom. Only reorders
  // the waiting queue — the leased `current` task keeps its slot.
  setHandler(reorderMergeSignal, ({ taskId, beforeTaskId }) => {
    if (!queue.includes(taskId)) return;
    const rest = queue.filter((t) => t !== taskId);
    const idx = beforeTaskId ? rest.indexOf(beforeTaskId) : -1;
    queue = idx < 0 ? [...rest, taskId] : [...rest.slice(0, idx), taskId, ...rest.slice(idx)];
  });
  setHandler(cancelMergeSignal, ({ taskId }) => {
    queue = queue.filter((t) => t !== taskId);
    if (current === taskId) current = undefined;
  });
  setHandler(queueQuery, (): QueueView => ({ domain, queue: [...queue], current }));

  for (;;) {
    // Park until there is something to grant, or we should recycle history.
    await condition(() => (!current && queue.length > 0) || (processed >= CONTINUE_AS_NEW_AFTER));

    if (processed >= CONTINUE_AS_NEW_AFTER && !current && queue.length === 0) {
      await continueAsNew<typeof mergeQueue>({ domain, state: { domain, queue, current, processed: 0 } });
    }

    if (!current && queue.length > 0) {
      const taskId = queue.shift()!;
      current = taskId;
      processed++;

      // Grant the slot by signaling the task's own workflow. If the task has
      // gone away, reclaim immediately.
      try {
        await getExternalWorkflowHandle(taskId).signal(MERGE_GRANTED_SIGNAL);
      } catch (e) {
        log.warn(`grant signal to ${taskId} failed; reclaiming`, { e: String(e) });
        current = undefined;
        continue;
      }

      // Await release, re-checking liveness once per lease window. This MUST
      // loop: with a single check, a grantee that is alive at the first timeout
      // (a long merge is entirely normal) but dies later holds the slot forever
      // — the park at the top of the loop blocks while `current` is set, so the
      // sweep never runs again, and release/cancel are reachable only from the
      // grantee's own workflow. Every task in the domain would then wait behind
      // a dead holder with no operator escape hatch.
      // Each iteration blocks for a full LEASE_TIMEOUT, so this cannot spin; and
      // it always exits with `current === undefined`, which is what the
      // continue-as-new guards below require.
      while (current === taskId) {
        if (await condition(() => current === undefined, LEASE_TIMEOUT)) break;
        if (!(await act.isTaskAlive(taskId))) {
          log.warn(`lease timeout; grantee ${taskId} not alive; reclaiming`);
          current = undefined;
          break;
        }
        // Grantee still working; give it another lease window.
      }
    }
    // Bound history even when continuously busy.
    if (processed >= CONTINUE_AS_NEW_AFTER && !current && queue.length === 0) {
      await continueAsNew<typeof mergeQueue>({ domain, state: { domain, queue, current, processed: 0 } });
    }
    void workflowInfo();
  }
}
