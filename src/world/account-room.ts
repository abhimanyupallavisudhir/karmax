import { BRAND } from '../domain/brand.js';
import { accountDiskGb, parkedHolds, providerDefaults, type AccountPool } from '../domain/computer-limits.js';
import type { Store } from '../store/db.js';
import { accountKey, enqueue, ordered, RESERVE_AFTER_MS, taskPriority, waiters, type Waiter } from './compute-queue.js';
import { DEFAULT_MANAGED_SHARE, MANAGED_COMPUTE, providerName } from './connections.js';

/**
 * Whether a provider account has room for one more machine (wiki
 * features/managed-compute § Budget and § Queue), for the installation's
 * managed accounts and for an organization's own alike:
 *   1. its budget — `pool.machines` machines at once, `pool.cpu` CPUs of the
 *      running ones, `pool.diskGb` of every disk that exists on it (parked
 *      worlds' too) — read from the provider, or entered where it cannot say;
 *   2. its queue — no task that waited first (compute-queue.ts) could take this
 *      room instead;
 *   3. on managed compute, the fair share — while another organization waits
 *      for it, an organization already holding a machine there may not pass
 *      its `share` (default 50%) of the budget.
 * A refused task joins the queue for the account. Nothing here is a lock:
 * a race can pass the budget by one, and the provider's own refusal then
 * waits the same way.
 */

export interface Account {
  provider: string;
  /** The installation's managed account, else the organization's own. */
  managed: boolean;
  pool?: AccountPool;
  share?: number;
}

export interface RoomRequest {
  organizationId: string;
  /** The task asking; without it nothing is queued. */
  taskId?: string;
  /** Its world, when it already exists (a wake): its disk and parked machine are counted already. */
  worldId?: string;
  cpu?: number;
  diskGb?: number;
  /** Look without joining the queue (the waker, a listing). */
  peek?: boolean;
}

export interface NoRoom {
  /** A few words, for the router's candidates. */
  reason: string;
  /** For the task's wait. */
  message: string;
}

/** What runs and exists on one account now. */
export interface AccountUse {
  machines: number;
  cpu: number;
  diskGb: number;
  /** Per organization (the fair share). */
  organizations: Map<string, { machines: number; cpu: number; diskGb: number }>;
  /** Worlds that exist on it: a wake of one of these takes no new disk. */
  worlds: Set<string>;
}

export async function accountUse(store: Store, provider: string, organizationId: string | null): Promise<AccountUse> {
  const size = (cpu: number | null | undefined) => cpu ?? providerDefaults(provider)?.cpu ?? 2;
  const holds = parkedHolds(provider);
  const [leases, live] = await Promise.all([store.runningLeases(provider, organizationId), store.liveWorlds(provider, organizationId)]);
  const use: AccountUse = { machines: 0, cpu: 0, diskGb: 0, organizations: new Map(), worlds: new Set(live.map((world) => world.worldId)) };
  const of = (organization: string) => {
    if (!use.organizations.has(organization)) use.organizations.set(organization, { machines: 0, cpu: 0, diskGb: 0 });
    return use.organizations.get(organization)!;
  };
  const leased = new Set(leases.map((lease) => lease.worldId));
  for (const lease of leases) {
    use.machines++; use.cpu += size(lease.cpu);
    const mine = of(lease.organizationId); mine.machines++; mine.cpu += size(lease.cpu);
  }
  for (const world of live) {
    const mine = of(world.organizationId);
    if (world.state === 'parked' && !leased.has(world.worldId) && holds.machine) { use.machines++; mine.machines++; }
    if (world.state === 'ready' || holds.disk) {
      const disk = accountDiskGb(provider, world.diskGb);
      use.diskGb += disk; mine.diskGb += disk;
    }
  }
  return use;
}

export async function accountRoom(store: Store, account: Account, request: RoomRequest, now = Date.now()): Promise<NoRoom | undefined> {
  const { provider, pool = {} } = account;
  const scope = account.managed ? MANAGED_COMPUTE : request.organizationId;
  const key = accountKey(scope, provider);
  const queue = await waiters(store, now);
  const queued = queue.some((waiter) => key in waiter.accounts);
  // Nothing to weigh and nobody waiting: the provider's own refusal is the limit.
  if (!pool.machines && !pool.cpu && !pool.diskGb && !queued) return undefined;
  const use = await accountUse(store, provider, account.managed ? null : request.organizationId);
  const cpu = request.cpu ?? providerDefaults(provider)?.cpu ?? 2;
  const exists = request.worldId !== undefined && use.worlds.has(request.worldId);
  const machine = exists && parkedHolds(provider).machine ? 0 : 1;
  const disk = exists ? 0 : accountDiskGb(provider, request.diskGb);
  const name = account.managed ? `${BRAND}'s ${providerName(provider)} computers` : `This organization's ${providerName(provider)} account`;
  let refusal: NoRoom | undefined;
  if (pool.machines && use.machines + machine > pool.machines)
    refusal = ({ reason: `all ${pool.machines} in use`, message: account.managed
      ? `All ${pool.machines} of ${name} are in use; waiting for one to free up.`
      : `${name} runs as many machines as it allows (${pool.machines}); waiting for one to free up.` });
  else if (pool.cpu && use.cpu + cpu > pool.cpu)
    refusal = ({ reason: `${use.cpu} of its ${pool.cpu} CPUs in use`, message: account.managed
      ? `${name} are using ${use.cpu} of their ${pool.cpu} CPUs; waiting for room.`
      : `${name} is using ${use.cpu} of its ${pool.cpu} CPUs; waiting for room.` });
  else if (pool.diskGb && use.diskGb + disk > pool.diskGb)
    refusal = ({ reason: `${use.diskGb} of its ${pool.diskGb} GB of disk taken`, message: account.managed
      ? `${name}' disks take ${use.diskGb} of their ${pool.diskGb} GB (parked ones too); waiting for room.`
      : `${name}'s disks take ${use.diskGb} of its ${pool.diskGb} GB (parked ones too); waiting for room.` });
  else if (queued && request.taskId) {
    // Room now: is it someone else's, who waited first and could take it?
    // Its place: where it waits, or where it would join — after everyone
    // already waiting (within its organization, at its priority).
    const me: Waiter = queue.find((waiter) => waiter.taskId === request.taskId)
      ?? { taskId: request.taskId, organizationId: request.organizationId, priority: await taskPriority(store, request.taskId),
        since: Number.POSITIVE_INFINITY, accounts: {} };
    const line = ordered([...queue.filter((waiter) => waiter.taskId !== me.taskId), { ...me, accounts: { ...me.accounts, [key]: now } }], key);
    const fits = (waiter: Waiter) => (!pool.cpu || use.cpu + (waiter.cpu ?? cpu) <= pool.cpu)
      && (!pool.diskGb || use.diskGb + accountDiskGb(provider, waiter.diskGb) <= pool.diskGb);
    const known = Boolean(pool.cpu || pool.diskGb || pool.machines);
    // Where the budget is known, one ahead blocks only if it could take this
    // room (or has waited long enough to keep it); else the order is strict.
    const ahead = line.slice(0, line.findIndex((waiter) => waiter.taskId === me.taskId))
      .filter((waiter) => !known || fits(waiter) || now - waiter.since >= RESERVE_AFTER_MS);
    if (ahead.length)
      refusal = ({ reason: `${ahead.length} waiting ahead`, message: `${ahead.length === 1 ? 'A task is' : `${ahead.length} tasks are`} waiting ahead of this one for `
        + `${account.managed ? name : `this organization's ${providerName(provider)} account`}; waiting its turn.` });
  }
  if (!refusal && account.managed && (pool.cpu || pool.machines)) {
    const mine = use.organizations.get(request.organizationId);
    const others = queue.some((waiter) => waiter.organizationId !== request.organizationId && key in waiter.accounts);
    const whole = pool.cpu ?? pool.machines!;
    const held = pool.cpu ? mine?.cpu ?? 0 : mine?.machines ?? 0;
    const share = (account.share ?? DEFAULT_MANAGED_SHARE) / 100;
    const unit = pool.cpu ? 'CPUs' : 'machines';
    if (mine?.machines && others && held + (pool.cpu ? cpu : 1) > share * whole)
      refusal = { reason: `its share (${held} of ${whole} ${unit}) while others wait`,
        message: `This organization already uses its share of ${name} (${held} of ${whole} ${unit}) while other organizations wait for one; waiting for one of its machines to finish.` };
  }
  if (refusal && request.taskId && !request.peek)
    await enqueue(store, { taskId: request.taskId, organizationId: request.organizationId, account: key,
      ...(request.cpu !== undefined ? { cpu: request.cpu } : {}), ...(request.diskGb !== undefined ? { diskGb: request.diskGb } : {}) }, now);
  return refusal;
}
