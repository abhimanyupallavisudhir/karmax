import { computeStandings } from '../scheduling/compute-order.js';
import type { Store } from '../store/db.js';

/**
 * Who waits for room on a provider account, in order (wiki
 * features/managed-compute § Queue).
 *
 * A task refused a machine for want of room — the account's budget is full,
 * tasks wait ahead of it, its organization is at its fair share, or the
 * provider itself refused — waits in this queue for each account it can use
 * (one for a named provider, several for "Any"). Admission
 * (account-room.ts) lets a task through only when no task ahead of it could
 * take the same room, and the waker (`wakeComputeQueue`) tells the first one
 * that now fits to try again at once instead of at its next retry.
 *
 * Order: across organizations, who waited first; within one organization,
 * the order the quota scheduler gives its trees (priority × how little the
 * tree has spent, people's placements, Run now), each tree's rank divided by
 * one more than the machines it holds, so a task with many sub-tasks gets its
 * share, not every machine (scheduling/compute-order.ts). Without that
 * (`withStandings` not applied, or it failed), the root's priority, then who
 * waited first. Neither ever jumps another organization's queue, so no
 * organization gets ahead by marking everything urgent.
 */

/** An account a task can wait for: `<scope>:<provider>`, the scope being the
 * installation (managed compute) or the organization (its own account). */
export type AccountKey = string;
export const accountKey = (scope: string, provider: string): AccountKey => `${scope}:${provider}`;

export interface Waiter {
  taskId: string;
  organizationId: string;
  priority: number;
  /** When it first waited (its place in the queue). */
  since: number;
  /** Each account it waits for, with when it last asked for it. */
  accounts: Record<AccountKey, number>;
  cpu?: number;
  diskGb?: number;
  /** When the waker last told it to try again. */
  signalled?: number;
  /** Its standing in its organization, computed when ordering (never stored): see `withStandings`. */
  rank?: number;
  within?: number;
  runNow?: boolean;
}

/** A waiter that has not asked for an account this long is gone (its task
 * found room elsewhere, ended, or stopped asking): retries come at most every
 * 5 minutes. */
export const WAITER_STALE_MS = 15 * 60_000;
/** A waiter this old keeps its place even when it does not fit the room that
 * frees up, so a large machine is not passed over forever by small ones. */
export const RESERVE_AFTER_MS = 10 * 60_000;

const KEY = 'compute-queue';

async function read(store: Store): Promise<Record<string, Waiter>> {
  try { return JSON.parse((await store.kvGet(KEY)) ?? '{}') as Record<string, Waiter>; } catch { return {}; }
}

/** Change the queue under its lock, dropping what went stale. */
async function change<T>(store: Store, now: number, fn: (queue: Record<string, Waiter>) => T): Promise<T> {
  return store.db.transaction(async () => {
    await store.db.lock(KEY);
    const queue = fresh(await read(store), now);
    const result = fn(queue);
    await store.kvSet(KEY, JSON.stringify(queue));
    return result;
  });
}

function fresh(queue: Record<string, Waiter>, now: number): Record<string, Waiter> {
  for (const [taskId, waiter] of Object.entries(queue)) {
    for (const [account, seen] of Object.entries(waiter.accounts)) if (now - seen >= WAITER_STALE_MS) delete waiter.accounts[account];
    if (!Object.keys(waiter.accounts).length) delete queue[taskId];
  }
  return queue;
}

/** Every waiter now, stale ones left out. */
export async function waiters(store: Store, now = Date.now()): Promise<Waiter[]> {
  return Object.values(fresh(await read(store), now));
}

/** A task was refused room on `account`: it waits there, keeping its place. */
export async function enqueue(store: Store, request: { taskId: string; organizationId: string; account: AccountKey; cpu?: number; diskGb?: number },
  now = Date.now()): Promise<void> {
  const priority = await taskPriority(store, request.taskId);
  await change(store, now, (queue) => {
    // A new waiter joins after everyone already waiting, even within one millisecond.
    const last = Math.max(0, ...Object.values(queue).map((waiter) => waiter.since));
    const waiter = queue[request.taskId] ?? { taskId: request.taskId, organizationId: request.organizationId, priority,
      since: Math.max(now, last + 1), accounts: {} };
    waiter.priority = priority;
    waiter.accounts[request.account] = now;
    if (request.cpu !== undefined) waiter.cpu = request.cpu;
    if (request.diskGb !== undefined) waiter.diskGb = request.diskGb;
    queue[request.taskId] = waiter;
  });
}

/** The task has its machine (or no longer wants one): it leaves the queue. */
export async function dequeue(store: Store, taskId: string, now = Date.now()): Promise<void> {
  if (!(await read(store))[taskId]) return;
  await change(store, now, (queue) => { delete queue[taskId]; });
}

export async function noteSignalled(store: Store, taskId: string, now = Date.now()): Promise<void> {
  await change(store, now, (queue) => { if (queue[taskId]) queue[taskId].signalled = now; });
}

const near = (x: number, y: number) => Math.abs(x - y) <= 1e-6 * Math.max(Math.abs(x), Math.abs(y));

type Ordering = Pick<Waiter, 'organizationId' | 'priority' | 'since' | 'taskId' | 'rank' | 'within' | 'runNow'>;

/** Whether `a` comes before `b` in the queue. */
export function before(a: Ordering, b: Ordering): boolean {
  if (a.taskId === b.taskId) return false;
  if (a.organizationId === b.organizationId) {
    if (a.rank !== undefined && b.rank !== undefined) {
      if (Boolean(a.runNow) !== Boolean(b.runNow)) return Boolean(a.runNow);
      // Ranks within a millionth are equal: people's placements nudge untouched ones by about that much.
      if (!near(a.rank, b.rank)) return a.rank > b.rank;
      if (!near(a.within ?? 1, b.within ?? 1)) return (a.within ?? 1) > (b.within ?? 1);
    } else if (a.priority !== b.priority) return a.priority > b.priority;
  }
  return a.since !== b.since ? a.since < b.since : a.taskId < b.taskId;
}

/**
 * The waiters with their standing in their organization filled in (rank,
 * within, runNow), for `ordered`. An organization with one waiter needs none;
 * one whose standings cannot be read keeps the priority order.
 */
export async function withStandings(store: Store, all: Waiter[], now = Date.now()): Promise<Waiter[]> {
  const byOrganization = new Map<string, Waiter[]>();
  for (const waiter of all) byOrganization.set(waiter.organizationId, [...(byOrganization.get(waiter.organizationId) ?? []), waiter]);
  const standing = new Map<string, Pick<Waiter, 'rank' | 'within' | 'runNow'>>();
  for (const [organization, list] of byOrganization) {
    if (list.length < 2) continue;
    try {
      const found = await computeStandings(store, organization,
        list.map((w) => ({ taskId: w.taskId, since: Number.isFinite(w.since) ? w.since : now })), now);
      for (const [taskId, s] of found) standing.set(taskId, s);
    } catch { /* the priority order */ }
  }
  return all.map((waiter) => {
    const s = standing.get(waiter.taskId);
    return s ? { ...waiter, rank: s.rank, within: s.within, ...(s.runNow ? { runNow: true } : {}) } : waiter;
  });
}

/** The waiters for `account` in queue order. Within each organization its
 * places in the arrival order are filled by its own waiters by priority. */
export function ordered(all: Waiter[], account: AccountKey): Waiter[] {
  const here = all.filter((waiter) => account in waiter.accounts)
    .sort((a, b) => (a.since === b.since ? (a.taskId < b.taskId ? -1 : 1) : a.since < b.since ? -1 : 1));
  const byOrganization = new Map<string, Waiter[]>();
  for (const waiter of here) byOrganization.set(waiter.organizationId, [...(byOrganization.get(waiter.organizationId) ?? []), waiter]);
  for (const list of byOrganization.values()) list.sort((a, b) => (before(a, b) ? -1 : before(b, a) ? 1 : 0));
  const next = new Map([...byOrganization].map(([organization]) => [organization, 0]));
  return here.map((waiter) => {
    const index = next.get(waiter.organizationId)!;
    next.set(waiter.organizationId, index + 1);
    return byOrganization.get(waiter.organizationId)![index]!;
  });
}

/** A task's priority for the queue: its root task's (sub-tasks share it),
 * none counting as medium (wiki features/quota-scheduling). */
export async function taskPriority(store: Store, taskId: string): Promise<number> {
  let task = await store.getTask(taskId);
  for (let depth = 0; task?.parentTaskId && depth < 16; depth++) task = await store.getTask(task.parentTaskId);
  const value = Number(task?.params?.priority);
  return Number.isInteger(value) && value > 0 ? value : 2;
}

/** A parked world its account had no room to wake, since when (kv). */
export const wakeFullKey = (worldId: string): string => `wake-full:${worldId}`;
/** How long a parked world waits for room where its disk is before the
 * lifecycle sweep moves it, from its park checkpoint, to where its task can
 * run now (runners.ts relocateStuckWakes). */
export const WAKE_RELOCATE_AFTER_MS = 15 * 60_000;
