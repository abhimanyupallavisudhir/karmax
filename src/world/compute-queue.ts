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
 * the higher priority first (its root task's, none counting as medium), then
 * who waited first. Priority never jumps another organization's queue, so no
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

/** Whether `a` comes before `b` in the queue. */
export function before(a: Pick<Waiter, 'organizationId' | 'priority' | 'since' | 'taskId'>, b: Pick<Waiter, 'organizationId' | 'priority' | 'since' | 'taskId'>): boolean {
  if (a.taskId === b.taskId) return false;
  if (a.organizationId === b.organizationId && a.priority !== b.priority) return a.priority > b.priority;
  return a.since !== b.since ? a.since < b.since : a.taskId < b.taskId;
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
