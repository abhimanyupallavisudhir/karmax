import type { Store } from '../store/db.js';
import type { ServiceConnection } from './service-connections.js';
import type { Via } from '../platform/sub-task-asks.js';

/** Where each app connection (and request for one) is kept. */
export const CONNECTION_PREFIX = 'service-connection:';
/** A request still waiting on a person: before sign-in, or during it. */
export const OPEN_CONNECTION: ServiceConnection['status'][] = ['requested', 'connecting'];

/** Does this connection hold its task's Do loop: an open request someone is
 * asked to answer, or an outcome its agent has not been told yet. An ignored
 * request asks nobody, so it holds nothing: the task goes on to its own ask
 * (LVPM #8 sat at "Connect the requested app" for days, its agent's reply
 * routed to no one). It stays decidable, and an answer still resumes the task. */
export function connectionHoldsTask(c: Pick<ServiceConnection, 'status' | 'dismissed' | 'notifiedAt'>): boolean {
  return OPEN_CONNECTION.includes(c.status) ? !c.dismissed : !c.notifiedAt;
}

/** Ignore every open connection request of a task, as a person's Ignore does
 * one (`ServiceConnections.dismiss`): the task settled, so no sign-in can reach
 * it. Kept apart from `ServiceConnections` so the store can call it. */
export async function ignoreTaskConnectionRequests(
  store: Pick<Store, 'transaction' | 'kvEntries' | 'kvSet' | 'appendEvent'>, taskId: string, by: string,
): Promise<ServiceConnection[]> {
  return store.transaction(async () => {
    const ignored: ServiceConnection[] = [];
    for (const { value } of (await store.kvEntries(CONNECTION_PREFIX))) {
      let c: ServiceConnection;
      try { c = JSON.parse(value); } catch { continue; }
      if (c.taskId !== taskId || !OPEN_CONNECTION.includes(c.status) || c.dismissed) continue;
      c.updatedAt = Date.now();
      c.dismissed = { by, at: c.updatedAt };
      (await store.kvSet(CONNECTION_PREFIX + c.id, JSON.stringify(c)));
      (await store.appendEvent({ taskId, type: 'connection.dismissed', ts: c.updatedAt, payload: { requestId: c.id } }));
      ignored.push(c);
    }
    return ignored;
  });
}

/** A task's open connection requests that came through `taskId` (its parent, sub-task-asks.ts). */
export async function connectionRequestsVia(
  store: Pick<Store, 'kvEntries'>, requesterId: string, taskId: string,
): Promise<ServiceConnection[]> {
  const asking: ServiceConnection[] = [];
  for (const { value } of (await store.kvEntries(CONNECTION_PREFIX))) {
    let c: ServiceConnection;
    try { c = JSON.parse(value); } catch { continue; }
    if (c.taskId === requesterId && OPEN_CONNECTION.includes(c.status) && c.via?.taskId === taskId) asking.push(c);
  }
  return asking;
}

/** Address a sub-task's connection request to the people its parent named,
 * with its note: announced again, now to them. */
export async function passOnConnectionRequest(
  store: Pick<Store, 'transaction' | 'kvGet' | 'kvSet' | 'appendEvent'>, id: string, audience: string[], via: Via,
): Promise<ServiceConnection | undefined> {
  return store.transaction(async () => {
    const raw = await store.kvGet(CONNECTION_PREFIX + id);
    const c: ServiceConnection | undefined = raw ? JSON.parse(raw) : undefined;
    if (!c?.taskId || !OPEN_CONNECTION.includes(c.status)) return undefined;
    c.updatedAt = via.at;
    c.audience = audience;
    c.via = via;
    delete c.dismissed;
    (await store.kvSet(CONNECTION_PREFIX + c.id, JSON.stringify(c)));
    (await store.appendEvent({ taskId: c.taskId, type: 'connection.requested', ts: c.updatedAt,
      payload: { requestId: c.id, connectionId: c.id, toolkit: c.toolkit, ...(c.why ? { why: c.why } : {}), audience, via } }));
    return c;
  });
}
