import type { World } from '../world/types.js';
import type { CdpSession } from './cdp.js';
import type { CredentialBroker } from './broker.js';
import { VaultItems, type VaultItem, type VaultItemStore } from './vault-items.js';
import { parseSavedSession, refreshSession } from './browser-session.js';

/**
 * Which tasks' browsers hold which saved sessions, so the vault copy follows
 * the site's own rotation without the agent's help, and so a session marked
 * "one task at a time" is in at most one browser.
 *
 * A task holds a session from the moment it saves or restores one until its
 * browser lets go of it: its world parks (the browser profile is not
 * checkpointed), is destroyed, or the task ends. While held, the session is
 * refreshed from that browser after every turn and once more on release
 * (`settleTaskSessions`, called from activity code).
 *
 * The lease of a one-at-a-time session is judged live lazily, from its
 * holder's state, so a missed release can delay another task but never wedge
 * it: a holder that ended, or whose lease has not been refreshed for a day,
 * has let go.
 */

interface HoldStore extends VaultItemStore {
  getTask(id: string): Promise<{ id: string; num?: number; title?: string; projectId: string; lastView?: { status?: string } } | undefined>;
  getProject(id: string): Promise<{ organizationId?: string } | undefined>;
}

const kvHolds = (taskId: string) => `vault:session-holds:${taskId}`;
const kvLease = (organizationId: string, itemId: string) => `vault:session-lease:${organizationId}:${itemId}`;
/** A lease its holder has not refreshed for this long is free. */
export const LEASE_STALE_MS = 24 * 3_600_000;
const ENDED = new Set(['done', 'cancelled', 'failed']);

interface Lease { taskId: string; at: number }

const read = async <T>(store: HoldStore, key: string): Promise<T | undefined> => {
  const raw = await store.kvGet(key);
  if (!raw) return undefined;
  try { return JSON.parse(raw) as T; } catch { return undefined; }
};

/** Record that `taskId`'s browser holds `itemId`. */
export async function recordHold(store: HoldStore, organizationId: string, taskId: string, itemId: string): Promise<void> {
  await store.transaction(async () => {
    await store.lock?.(`kv:${kvHolds(taskId)}`);
    const holds = (await read<Array<{ itemId: string; organizationId: string }>>(store, kvHolds(taskId))) ?? [];
    if (!holds.some((h) => h.itemId === itemId)) await store.kvSet(kvHolds(taskId), JSON.stringify([...holds, { itemId, organizationId }]));
  });
}

/** The task that holds a one-at-a-time session, if another live task does. */
async function liveHolder(store: HoldStore, lease: Lease | undefined, taskId: string, now: number) {
  if (!lease || lease.taskId === taskId || now - lease.at > LEASE_STALE_MS) return undefined;
  const holder = await store.getTask(lease.taskId);
  if (!holder || ENDED.has(holder.lastView?.status ?? '')) return undefined;
  return holder;
}

/**
 * Take the lease of a one-at-a-time session for `taskId`, or name the live
 * task that has it. Sessions shared by any number of tasks need no lease.
 */
export async function acquireLease(store: HoldStore, organizationId: string, item: VaultItem, taskId: string, now = Date.now()):
  Promise<{ granted: true } | { granted: false; heldBy: { taskId: string; num?: number; title?: string } }> {
  if (!item.exclusive) return { granted: true };
  return store.transaction(async () => {
    // One live holder at a time.
    await store.lock?.(`kv:${kvLease(organizationId, item.id)}`);
    const holder = await liveHolder(store, await read<Lease>(store, kvLease(organizationId, item.id)), taskId, now);
    if (holder) return { granted: false as const, heldBy: { taskId: holder.id, ...(holder.num !== undefined ? { num: holder.num } : {}), ...(holder.title ? { title: holder.title } : {}) } };
    await store.kvSet(kvLease(organizationId, item.id), JSON.stringify({ taskId, at: now }));
    return { granted: true as const };
  });
}

/** Give back a lease `taskId` took for a restore that did not happen. */
export async function releaseLease(store: HoldStore, organizationId: string, itemId: string, taskId: string): Promise<void> {
  await store.transaction(async () => {
    await store.lock?.(`kv:${kvLease(organizationId, itemId)}`);
    const lease = await read<Lease>(store, kvLease(organizationId, itemId));
    if (lease?.taskId === taskId) await store.kvDelete?.(kvLease(organizationId, itemId));
  });
}

/** Opens a page of `world`'s browser, preferring one on `domains`. */
export type SessionPageOpener = (world: World, domains: string[]) => Promise<{ session: CdpSession }>;

/**
 * Refresh every session `taskId`'s browser holds into the vault and, with
 * `release`, let go of them. `world` is the task's world while its browser is
 * reachable (it outlives turns in remote and container worlds); without one,
 * holds are only released. Best effort: a session that cannot be read keeps
 * its stored copy, and a failure never fails the caller.
 */
export async function settleTaskSessions(args: {
  store: HoldStore; broker?: CredentialBroker; taskId: string; release: boolean;
  /** The world, or how to open it; opened only when the task holds a session. */
  world?: World | (() => Promise<World | undefined>);
  openPage?: SessionPageOpener; now?: () => number;
}): Promise<{ refreshed: string[]; released: string[] }> {
  const { store, taskId } = args;
  const now = args.now ?? Date.now;
  const holds = (await read<Array<{ itemId: string; organizationId: string }>>(store, kvHolds(taskId))) ?? [];
  const refreshed: string[] = [], released: string[] = [];
  if (!holds.length) return { refreshed, released };
  let world: World | undefined;
  try { world = typeof args.world === 'function' ? await args.world() : args.world; } catch { world = undefined; }
  for (const hold of holds) {
    try {
      const vault = new VaultItems(store, args.broker, undefined, hold.organizationId);
      const item = await vault.get(hold.itemId);
      if (item?.type === 'session' && world && args.broker && args.openPage && item.domains?.length) {
        const raw = vault.readSecret(item, 'session');
        if (raw) {
          const page = await args.openPage(world, item.domains);
          try {
            const { saved, changed } = await refreshSession(page.session, item.domains, parseSavedSession(raw), now());
            if (changed) {
              await vault.save({ id: item.id, type: 'session', secrets: { session: JSON.stringify(saved) } });
              await store.appendAudit({ principalId: `task:${taskId}`, action: 'vault.session.refreshed', detail: { itemId: item.id, label: item.label } });
              refreshed.push(item.id);
            }
          } finally { await page.session.close(); }
        }
      }
      if (item?.exclusive && !args.release) {
        await store.transaction(async () => {
          await store.lock?.(`kv:${kvLease(hold.organizationId, hold.itemId)}`);
          const lease = await read<Lease>(store, kvLease(hold.organizationId, hold.itemId));
          if (lease?.taskId === taskId) await store.kvSet(kvLease(hold.organizationId, hold.itemId), JSON.stringify({ taskId, at: now() }));
        });
      }
    } catch { /* keep the stored copy; the next settle tries again */ }
  }
  if (args.release) {
    await store.transaction(async () => {
      await store.lock?.(`kv:${kvHolds(taskId)}`,
        ...[...new Set(holds.map((hold) => `kv:${kvLease(hold.organizationId, hold.itemId)}`))].sort());
      for (const hold of holds) {
        const lease = await read<Lease>(store, kvLease(hold.organizationId, hold.itemId));
        if (lease?.taskId === taskId) await store.kvDelete?.(kvLease(hold.organizationId, hold.itemId));
      }
      await store.kvDelete?.(kvHolds(taskId));
    });
    released.push(...holds.map((hold) => hold.itemId));
  }
  return { refreshed, released };
}
