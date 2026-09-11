import {
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  defineUpdate,
  getExternalWorkflowHandle,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import {
  QRY_AGENT_QUEUE,
  SIG_AGENT_SLOT_GRANTED,
  SIG_CANCEL_AGENT,
  SIG_LEASE_AGENT,
  SIG_REQUEST_AGENT,
  SIG_RELEASE_AGENT,
  SIG_REORDER,
  SIG_SET_AGENT_CAPACITY,
  UPD_REQUEST_AGENT,
  UPD_WAIT_AGENT,
  agentQueueId as aqId,
} from './names.js';

export interface AgentQueueItem {
  taskId: string;
  turnId: string;
  role: string;
  provider?: string;
  title?: string;
  projectId?: string;
}

export interface AgentQueueView {
  capacity: number;
  queue: AgentQueueItem[];
  current: AgentQueueItem[];
}

interface AgentQueueRecord extends AgentQueueItem {
  /** V2 requests are granted back to their owning workflow by signal. */
  protocol?: 2;
}

interface AgentQueueState {
  capacity: number;
  queue: AgentQueueRecord[];
  current: AgentQueueRecord[];
  processed: number;
  modern?: boolean;
}

export const leaseAgentSignal = defineSignal<[AgentQueueItem]>(SIG_LEASE_AGENT);
export const requestAgentSignal = defineSignal<[AgentQueueItem]>(SIG_REQUEST_AGENT);
export const cancelAgentSignal = defineSignal<[{ taskId: string; turnId: string }]>(SIG_CANCEL_AGENT);
export const releaseAgentSignal = defineSignal<[{ taskId: string; turnId: string }]>(SIG_RELEASE_AGENT);
export const reorderAgentSignal = defineSignal<[{ turnId: string; beforeTurnId?: string }]>(SIG_REORDER);
export const setAgentCapacitySignal = defineSignal<[{ capacity: number }]>(SIG_SET_AGENT_CAPACITY);
export const waitAgentUpdate = defineUpdate<boolean, [AgentQueueItem]>(UPD_WAIT_AGENT);
export const requestAgentUpdate = defineUpdate<
  { granted: boolean; position: number; capacity: number },
  [AgentQueueItem]
>(UPD_REQUEST_AGENT);
export const agentQueueQuery = defineQuery<AgentQueueView>(QRY_AGENT_QUEUE);

export const agentQueueId = aqId;

const LEGACY_CONTINUE_AS_NEW_AFTER = 500;
const CONTINUE_AS_NEW_AFTER = 50;
const LEASE_TIMEOUT = '5 minutes';
const act = proxyActivities<{ isTaskAlive(taskId: string): Promise<boolean> }>({ startToCloseTimeout: '20s' });

/**
 * Durable, host-wide admission queue for model turns. The turn activity requests
 * a lease before it starts the expensive model process, so queue order and active
 * leases are workflow state (queryable/reorderable) rather than process-local
 * semaphore bookkeeping. Memory/load pressure remains an activity-side safety
 * check because only the worker can inspect the live host.
 */
export async function agentQueue(input: { capacity?: number; state?: AgentQueueState } = {}): Promise<void> {
  let capacity = nonNegativeInt(input.state?.capacity ?? input.capacity, 3);
  let queue = input.state?.queue ?? [];
  let current = input.state?.current ?? [];
  let processed = input.state?.processed ?? 0;
  let modern = input.state?.modern ?? false;
  let legacyWaiters = 0;

  setHandler(leaseAgentSignal, (item) => {
    if (!current.some((x) => x.turnId === item.turnId) && !queue.some((x) => x.turnId === item.turnId)) queue.push(item);
  });
  setHandler(requestAgentSignal, (item) => {
    modern = true;
    if (!current.some((x) => x.turnId === item.turnId) && !queue.some((x) => x.turnId === item.turnId))
      queue.push({ ...item, protocol: 2 });
  });
  setHandler(cancelAgentSignal, ({ taskId, turnId }) => {
    queue = queue.filter((x) => x.turnId !== turnId || x.taskId !== taskId);
    current = current.filter((x) => x.turnId !== turnId || x.taskId !== taskId);
  });
  setHandler(releaseAgentSignal, ({ taskId, turnId }) => {
    current = current.filter((x) => x.turnId !== turnId || x.taskId !== taskId);
  });
  setHandler(reorderAgentSignal, ({ turnId, beforeTurnId }) => {
    const item = queue.find((x) => x.turnId === turnId);
    if (!item) return;
    const rest = queue.filter((x) => x.turnId !== turnId);
    const idx = beforeTurnId ? rest.findIndex((x) => x.turnId === beforeTurnId) : -1;
    queue = idx < 0 ? [...rest, item] : [...rest.slice(0, idx), item, ...rest.slice(idx)];
  });
  setHandler(setAgentCapacitySignal, ({ capacity: next }) => {
    capacity = nonNegativeInt(next, capacity);
  });
  // A waiter durably enqueues and blocks in one Update. The separate
  // signalWithStart remains the crash-safe way to create the singleton, while
  // the Update's idempotent enqueue closes their cross-request ordering race.
  // One accepted Update replaces the former 10Hz consistent-query loop in every
  // waiting activity. Cancellation removes the item and resolves `false`.
  setHandler(waitAgentUpdate, async (item) => {
    legacyWaiters++;
    const matches = (candidate: AgentQueueItem) =>
      candidate.taskId === item.taskId && candidate.turnId === item.turnId;
    try {
      // signalWithStart acceptance and a subsequent Update are separate client
      // requests, so their server-side processing order is not guaranteed. Make
      // the Update idempotently enqueue too; otherwise an early Update can observe
      // "not queued" and falsely report cancellation.
      if (!current.some(matches) && !queue.some(matches)) queue.push(item);
      await condition(() =>
        current.some(matches)
        || !queue.some(matches)
        || (current.length < capacity && !!queue[0] && matches(queue[0])),
      );
      if (!current.some(matches) && queue.some(matches) && current.length < capacity) {
        queue = queue.filter((candidate) => !matches(candidate));
        current.push(item);
        processed++;
      }
      return current.some(matches);
    } finally {
      legacyWaiters--;
    }
  });
  // V2 admission acknowledges immediately. It never parks an Update handler:
  // the owning task waits for SIG_AGENT_SLOT_GRANTED after a queued request is
  // promoted, which lets this coordinator continue-as-new with waiters intact.
  setHandler(requestAgentUpdate, (item) => {
    modern = true;
    const matches = (candidate: AgentQueueItem) =>
      candidate.taskId === item.taskId && candidate.turnId === item.turnId;
    if (!current.some(matches) && !queue.some(matches)) queue.push({ ...item, protocol: 2 });
    if (!current.some(matches) && current.length < capacity && queue[0] && matches(queue[0])) {
      queue.shift();
      current.push({ ...item, protocol: 2 });
      processed++;
    }
    if (current.some(matches)) return { granted: true, position: 0, capacity };
    const index = queue.findIndex(matches);
    return { granted: false, position: index < 0 ? -1 : index + 1, capacity };
  });
  const publicItem = ({ protocol: _protocol, ...item }: AgentQueueRecord): AgentQueueItem => item;
  setHandler(agentQueueQuery, () => ({
    capacity,
    queue: queue.map(publicItem),
    current: current.map(publicItem),
  }));

  for (;;) {
    const shouldRotate = () =>
      modern
      && legacyWaiters === 0
      && (processed >= CONTINUE_AS_NEW_AFTER || workflowInfo().continueAsNewSuggested);
    const ready = () =>
      (queue.length > 0 && current.length < capacity)
      || shouldRotate()
      || (!modern && processed >= LEGACY_CONTINUE_AS_NEW_AFTER && current.length === 0);
    const changed = current.length ? await condition(ready, LEASE_TIMEOUT) : (await condition(ready), true);
    if (!changed && current.length) {
      // Signals land during the probe (a release shrinks `current`, a grant grows
      // it), so drop the dead leases by identity, never by the probed index.
      const probed = current;
      const alive = await Promise.all(probed.map((item) => act.isTaskAlive(item.taskId)));
      const dead = new Set(probed.filter((_, i) => !alive[i]).map((item) => item.turnId));
      if (dead.size) current = current.filter((item) => !dead.has(item.turnId));
      continue;
    }
    if (shouldRotate() || (!modern && processed >= LEGACY_CONTINUE_AS_NEW_AFTER && current.length === 0)) {
      await continueAsNew<typeof agentQueue>({
        capacity,
        state: { capacity, queue, current, processed: 0, modern },
      });
    }
    while (queue.length > 0 && current.length < capacity) {
      const item = queue.shift()!;
      current.push(item);
      processed++;
      if (item.protocol === 2) {
        try {
          await getExternalWorkflowHandle(item.taskId).signal(SIG_AGENT_SLOT_GRANTED, {
            turnId: item.turnId,
          });
        } catch {
          // The owning task disappeared before promotion. Reclaim immediately;
          // the periodic liveness sweep remains a fallback for older leases.
          current = current.filter((candidate) => candidate.turnId !== item.turnId);
        }
      }
    }
  }
}

function nonNegativeInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}
