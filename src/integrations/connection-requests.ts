import type { Store } from '../store/db.js';
import type { ServiceConnection } from './service-connections.js';

/** Where each app connection (and request for one) is kept. */
export const CONNECTION_PREFIX = 'service-connection:';
/** A request still waiting on a person: before sign-in, or during it. */
export const OPEN_CONNECTION: ServiceConnection['status'][] = ['requested', 'connecting'];

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
