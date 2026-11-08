import type { Store } from '../store/db.js';
import type { RunnerPool, TaskView } from '../domain/types.js';
import { ProviderCapacityFull } from '../agent/limits.js';

/**
 * A task waiting for a runner lease — admission to its organization's
 * computers (RunnerPoolService.acquire, a `queued` world_leases row) — says
 * so, as a provider's refusal does: "Waiting for a machine", its place in the
 * queue and what is full (wiki features/managed-compute § Queue).
 *
 * The queued row is the truth, whoever asked for it (a new world, a restore,
 * a wake, a terminal, a handoff, Confirm's landing): the view a task serves
 * takes it at read time (KarmaxApi.withLiveWait), as a model login's wait
 * does, and `world.machine-wait` events tell open pages to read again. On
 * 2026-11-04 every org_personal task waited 12 h for a lease while their
 * pages read "Starting agent" or "Setup" (wiki incidents/lessons).
 */

/** The summary of every wait for a machine (the workflow's provider-refusal wait uses the same). */
export const MACHINE_WAIT = 'Waiting for a machine';
/** The event that tells live pages a task started or stopped waiting for a lease. */
export const MACHINE_WAIT_EVENT = 'world.machine-wait';

export interface MachineWait {
  provider: string;
  /** Leases admitted before it, in its queue. */
  ahead: number;
  /** What is full, where, and its place, in a sentence or two. */
  detail: string;
  /** When it first asked (its place). */
  since: number;
  runnerPoolId: string;
}

/** A lease still queued when its caller's time to wait ran out. The workflow
 * waits for a machine and tries again ('world-capacity'); the place is kept. */
export class MachineQueued extends ProviderCapacityFull {
  constructor(message: string) {
    super(message);
    // Not a provider's own refusal: the router must not mark the provider full
    // (compute-router.ts noteFull) for room our own queue keeps.
    this.name = 'MachineQueued';
  }
}

const REMOTE = (provider: string) => !['worktree', 'container', 'memory'].includes(provider);

/** Who a queued lease waits behind: the organization's remote leases where
 * the plan's concurrency admits them (requestWorldLease), else its pool. */
function queueOf(store: Store, pool: RunnerPool | undefined, lease: { organizationId: string; runnerPoolId: string }): string {
  return pool && REMOTE(pool.provider) && store.hosted && (pool.mode === 'customer' || pool.mode === 'managed')
    ? `organization:${lease.organizationId}` : `pool:${lease.runnerPoolId}`;
}

/** Every task waiting for a lease now, with its wait (the earliest place when it holds several). */
export async function machineWaits(store: Store): Promise<Map<string, MachineWait>> {
  const queued = await store.queuedWorldLeases();
  const waits = new Map<string, MachineWait>();
  if (!queued.length) return waits;
  const pools = new Map<string, RunnerPool | undefined>();
  const poolOf = async (id: string) => {
    if (!pools.has(id)) pools.set(id, await store.getRunnerPool(id));
    return pools.get(id);
  };
  const places = new Map<string, number>();
  const reasons = new Map<string, string>();
  for (const lease of queued) {
    const pool = await poolOf(lease.runnerPoolId);
    const queue = queueOf(store, pool, lease);
    const ahead = places.get(queue) ?? 0;
    places.set(queue, ahead + 1);
    if (!reasons.has(queue)) reasons.set(queue, await fullReason(store, pool, lease.organizationId, queue));
    const previous = waits.get(lease.taskId);
    if (previous && previous.ahead <= ahead) continue;
    // Its world already runs on a lease (a terminal or preview waits for one
    // of its own): the task itself waits for nothing.
    if (await store.activeWorldLeaseCount(lease.worldId)) continue;
    waits.set(lease.taskId, { provider: pool?.provider ?? 'unknown', ahead, since: Number(lease.queuedSince ?? lease.createdAt),
      runnerPoolId: lease.runnerPoolId, detail: `${reasons.get(queue)!}${aheadText(ahead)}` });
  }
  return waits;
}

/** The wait of one task, if it waits for a lease. */
export async function machineWait(store: Store, taskId: string): Promise<MachineWait | undefined> {
  return (await machineWaits(store)).get(taskId);
}

const aheadText = (ahead: number) => ahead ? ` ${ahead === 1 ? '1 task is' : `${ahead} tasks are`} ahead of this one.` : '';

async function fullReason(store: Store, pool: RunnerPool | undefined, organizationId: string, queue: string): Promise<string> {
  const where = pool ? ` (${pool.name})` : '';
  if (queue.startsWith('organization:')) {
    const { maxActiveWorlds } = await store.getOrganizationUsagePolicy(organizationId);
    return `All ${maxActiveWorlds} computers this organization may run at once are in use${where}.`;
  }
  if (!pool) return 'Waiting for room in its runner pool.';
  const active = (await store.listWorldLeases(pool.id)).filter((lease) => lease.state === 'active').length;
  return active >= pool.capacity.activeWorlds
    ? `All ${pool.capacity.activeWorlds} machines of ${pool.name} are in use.`
    : `${pool.name} has no CPU or memory free for this machine.`;
}

/** Waits a person answers; a machine wait (a terminal opened at Review) never hides them. */
const PERSON_WAITS = new Set(['human', 'confirm', 'parent', 'responder']);

/** The view of a task that waits for a lease: waiting for a machine. */
export function withMachineWait<V extends Pick<TaskView, 'status' | 'waitingFor'>>(view: V, wait: MachineWait | undefined): V {
  if (!wait || ['done', 'cancelled', 'failed'].includes(view.status) || PERSON_WAITS.has(view.waitingFor?.kind ?? '')) return view;
  return { ...view, status: 'waiting', waitingFor: { kind: 'retry', summary: MACHINE_WAIT, detail: wait.detail, provider: wait.provider, ahead: wait.ahead } };
}

/** A caller that stops waiting and asks again keeps its place for this long
 * after it gave up (the workflow tries again within five minutes). */
export const PLACE_KEPT_MS = 15 * 60_000;

/** Where `taskId`'s world `worldId` stands in the queue if it gave up at its
 * deadline and asks again within PLACE_KEPT_MS: when it first asked. */
export async function keptPlace(store: Store, taskId: string, worldId: string, now = Date.now()): Promise<number | undefined> {
  try {
    const kept = JSON.parse((await store.kvGet(placeKey(taskId, worldId))) ?? 'null') as { since: number; seen: number } | null;
    return kept && now - kept.seen < PLACE_KEPT_MS ? kept.since : undefined;
  } catch { return undefined; }
}

/** It gives up waiting for now: keep its place for its next try. */
export async function keepPlace(store: Store, taskId: string, worldId: string, since: number, now = Date.now()): Promise<void> {
  await store.kvSet(placeKey(taskId, worldId), JSON.stringify({ since, seen: now }));
}

/** It has its machine (or stopped for another reason): no place to keep. */
export async function forgetPlace(store: Store, taskId: string, worldId: string): Promise<void> {
  await store.kvDelete(placeKey(taskId, worldId));
}

const placeKey = (taskId: string, worldId: string) => `machine-place:${taskId}:${worldId}`;

/** How long an activity may wait for its lease: half of what it may run, so
 * the work after admission still fits (Temporal ActivityInfo). */
export function leaseWaitDeadline(info: { currentAttemptScheduledTimestampMs?: number; startToCloseTimeoutMs?: number } | undefined): number | undefined {
  if (!info?.startToCloseTimeoutMs || !info.currentAttemptScheduledTimestampMs) return undefined;
  return info.currentAttemptScheduledTimestampMs + Math.floor(info.startToCloseTimeoutMs / 2);
}
