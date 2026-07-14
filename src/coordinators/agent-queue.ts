import {
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
import {
  QRY_AGENT_QUEUE,
  SIG_CANCEL_AGENT,
  SIG_LEASE_AGENT,
  SIG_RELEASE_AGENT,
  SIG_REORDER,
  SIG_SET_AGENT_CAPACITY,
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

interface AgentQueueState extends AgentQueueView {
  processed: number;
}

export const leaseAgentSignal = defineSignal<[AgentQueueItem]>(SIG_LEASE_AGENT);
export const cancelAgentSignal = defineSignal<[{ taskId: string; turnId: string }]>(SIG_CANCEL_AGENT);
export const releaseAgentSignal = defineSignal<[{ taskId: string; turnId: string }]>(SIG_RELEASE_AGENT);
export const reorderAgentSignal = defineSignal<[{ turnId: string; beforeTurnId?: string }]>(SIG_REORDER);
export const setAgentCapacitySignal = defineSignal<[{ capacity: number }]>(SIG_SET_AGENT_CAPACITY);
export const agentQueueQuery = defineQuery<AgentQueueView>(QRY_AGENT_QUEUE);

export const agentQueueId = aqId;

const CONTINUE_AS_NEW_AFTER = 500;
const LEASE_TIMEOUT = '5 minutes';
const act = proxyActivities<{ isTaskAlive(taskId: string): Promise<boolean> }>({ startToCloseTimeout: '20s' });

/**
 * Durable, host-wide admission queue for model turns. The task workflow requests
 * a lease before it schedules the expensive activity, so queue order and active
 * leases are workflow state (queryable/reorderable) rather than process-local
 * semaphore bookkeeping. Memory/load pressure remains an activity-side safety
 * check because only the worker can inspect the live host.
 */
export async function agentQueue(input: { capacity?: number; state?: AgentQueueState } = {}): Promise<void> {
  let capacity = positiveInt(input.state?.capacity ?? input.capacity, 3);
  let queue = input.state?.queue ?? [];
  let current = input.state?.current ?? [];
  let processed = input.state?.processed ?? 0;

  setHandler(leaseAgentSignal, (item) => {
    if (!current.some((x) => x.turnId === item.turnId) && !queue.some((x) => x.turnId === item.turnId)) queue.push(item);
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
    capacity = positiveInt(next, capacity);
  });
  setHandler(agentQueueQuery, () => ({ capacity, queue: queue.map((x) => ({ ...x })), current: current.map((x) => ({ ...x })) }));

  for (;;) {
    const ready = () => (queue.length > 0 && current.length < capacity) || (processed >= CONTINUE_AS_NEW_AFTER && current.length === 0);
    const changed = current.length ? await condition(ready, LEASE_TIMEOUT) : (await condition(ready), true);
    if (!changed && current.length) {
      const alive = await Promise.all(current.map((item) => act.isTaskAlive(item.taskId)));
      current = current.filter((_, i) => alive[i]);
      continue;
    }
    if (processed >= CONTINUE_AS_NEW_AFTER && current.length === 0) {
      await continueAsNew<typeof agentQueue>({ capacity, state: { capacity, queue, current, processed: 0 } });
    }
    while (queue.length > 0 && current.length < capacity) {
      const item = queue.shift()!;
      current.push(item);
      processed++;
    }
  }
}

function positiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
