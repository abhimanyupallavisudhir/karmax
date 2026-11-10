/**
 * Change notices: "something the console shows was written through the API".
 *
 * The live stream (`/ws`) is fed by durable task events, and the console
 * re-reads what an event names. But most writes record no event — archiving,
 * tags, priority, notes, a saved view, a setting, reading an inbox ask — so a
 * second tab, a phone, a colleague, or the person watching while an agent made
 * the change kept showing the old state until a reload. Each such write would
 * have needed its own event and its own handler in the console, and each new
 * route would have had to remember both.
 *
 * Instead the gateway — the only thing people's and agents' requests go
 * through — says so once, for every request that wrote: which task, project
 * and organization it addressed (the scope it was authorized against) and the
 * capability's resource as a coarse `area`. The console re-reads what it shows
 * of that scope. A notice carries no content, so hearing one too many costs a
 * read; missing one is the stale page this exists to prevent.
 *
 * Notices are not durable and not ordered with events: a socket that was not
 * connected re-reads everything when it connects, as it does for events. They
 * are published in this process; a deployment with several gateways would
 * carry them between gateways (the console also re-reads when a page comes
 * back into view).
 */
export interface ChangeNotice {
  /** The capability's resource (`task`, `project`, `inbox`, …). */
  area: string;
  organizationId?: string;
  projectId?: string;
  taskId?: string;
  /** The one person whose connections hear it: their own state (their inbox,
   * their preferences), or a write of theirs that names no organization. */
  personal?: string;
  /** The console tab that made the request: it applied the change itself. */
  client?: string;
}

/** One person's own state (what they have read, their preferences): nobody
 * else's page shows it. (`/api/users` is the installation's accounts.) */
const PERSONAL = /^\/api\/(?:inbox|user)(?:\/|$)/;

/** Requests that are not GETs yet write nothing a page shows. Rendering a
 * Review asks for its files' signed URLs with a POST; were that a change, two
 * tabs on one task would re-read each other's renders. */
const READ_ONLY_CAPABILITIES = new Set(['task:review:execute']);

const CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/;
export const clientId = (value: unknown): string | undefined =>
  typeof value === 'string' && CLIENT_ID.test(value) ? value : undefined;

export interface ChangeScope { organizationId?: string; projectId?: string; taskId?: string }

/** What a request wrote to: the record it addressed, or, for an agent's write
 * that addresses none (`/api/agent/…`, a vault request), the agent's own task. */
export async function writtenScope(requested: ChangeScope, caller: { kind?: string; taskId?: string } | undefined,
  store: { taskProjectIdAsync(taskId: string): Promise<string | undefined>; projectOrganizationAsync(projectId: string): Promise<string | undefined> }): Promise<ChangeScope> {
  if (requested.projectId || requested.taskId || caller?.kind !== 'agent' || !caller.taskId || caller.taskId === '*') return requested;
  const projectId = await store.taskProjectIdAsync(caller.taskId);
  const organizationId = projectId ? await store.projectOrganizationAsync(projectId) : undefined;
  return projectId && organizationId ? { taskId: caller.taskId, projectId, organizationId } : requested;
}

/** The notice a finished request gives, if it wrote anything. */
export function changeNoticeFor(request: {
  method: string; path: string; status: number;
  /** The capability the route required (`routeCapability`). */
  capability?: string;
  scope: ChangeScope;
  /** The person the caller acts as, if any. */
  userId?: string;
  /** The `x-tavya-client` header, as received. */
  client?: unknown;
}): ChangeNotice | undefined {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method) || request.status >= 400) return undefined;
  const capability = request.capability && request.capability !== 'none' ? request.capability : undefined;
  if (capability && (capability.endsWith(':read') || READ_ONLY_CAPABILITIES.has(capability))) return undefined;
  const area = capability?.split(':')[0] ?? request.path.split('/')[2] ?? '';
  const client = clientId(request.client);
  if (PERSONAL.test(request.path)) {
    if (!request.userId) return undefined;
    return { area, personal: request.userId, ...(request.scope.organizationId ? { organizationId: request.scope.organizationId } : {}),
      ...(client ? { client } : {}) };
  }
  // A write that names no organization (an organization or project just made,
  // an installation setting) is told to its writer's other connections: what
  // it made is theirs, and whose else it is cannot be read off the request.
  if (!request.scope.organizationId) return request.userId ? { area, personal: request.userId, ...(client ? { client } : {}) } : undefined;
  return { area, organizationId: request.scope.organizationId,
    ...(request.scope.projectId ? { projectId: request.scope.projectId } : {}),
    ...(request.scope.taskId ? { taskId: request.scope.taskId } : {}),
    ...(client ? { client } : {}) };
}

export class ChangeNotices {
  private listeners = new Set<(notice: ChangeNotice) => unknown>();
  on(listener: (notice: ChangeNotice) => unknown): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  publish(notice: ChangeNotice): void {
    for (const listener of this.listeners) {
      try {
        const result = listener(notice);
        if (result && typeof (result as PromiseLike<unknown>).then === 'function')
          void Promise.resolve(result).catch((error) => console.error('[change notices] subscriber failed:', error));
      } catch (error) { console.error('[change notices] subscriber failed:', error); }
    }
  }
}
