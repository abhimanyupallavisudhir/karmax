const ACTIVE_RUNTIME_KEY = 'runtime:active';

export interface RuntimeRecord {
  runtimeId: string;
  startedAt: number;
  pid: number;
  version: string;
  buildRevision?: string;
  node: string;
}

interface RuntimeLifecycleStore {
  kvGet(key: string): (string | undefined) | Promise<string | undefined>;
  kvSet(key: string, value: string): (unknown) | Promise<unknown>;
  kvDelete(key: string): (void) | Promise<void>;
  appendAudit(entry: {
    ts?: number;
    principalId: string;
    action: string;
    scopeKey?: string;
    detail?: Record<string, unknown>;
  }): (number) | Promise<number>;
}

const audit = async (store: RuntimeLifecycleStore, action: string, at: number, detail: Record<string, unknown>) =>
  (await store.appendAudit({ ts: at, principalId: 'system:runtime', action, scopeKey: 'global', detail }));

/** Persist incarnation boundaries outside container logs. If the active marker
 * survives, the prior process never reached its graceful shutdown path; the next
 * boot turns that absence into an explicit, queryable incident. */
export async function beginRuntimeLifecycle(store: RuntimeLifecycleStore, record: RuntimeRecord): Promise<RuntimeRecord> {
  const raw = (await store.kvGet(ACTIVE_RUNTIME_KEY));
  if (raw) {
    try {
      const previous = JSON.parse(raw) as Record<string, unknown>;
      if (previous.runtimeId !== record.runtimeId) {
        (await audit(store, 'runtime.previous-unclean', record.startedAt, { previous, detectedBy: record.runtimeId }));
      }
    } catch {
      (await audit(store, 'runtime.previous-unclean', record.startedAt, { previous: { malformed: true }, detectedBy: record.runtimeId }));
    }
  }
  (await store.kvSet(ACTIVE_RUNTIME_KEY, JSON.stringify(record)));
  (await audit(store, 'runtime.started', record.startedAt, { ...record }));
  return record;
}

export async function endRuntimeLifecycle(
  store: RuntimeLifecycleStore,
  record: RuntimeRecord,
  stop: { stoppedAt: number; reason: string; restart: boolean },
): Promise<void> {
  (await audit(store, 'runtime.stopped', stop.stoppedAt, {
    runtimeId: record.runtimeId,
    reason: stop.reason,
    restart: stop.restart,
    uptimeMs: Math.max(0, stop.stoppedAt - record.startedAt),
  }));
  // Never erase a newer incarnation's marker during overlapping supervisor handoff.
  try {
    const current = JSON.parse((await store.kvGet(ACTIVE_RUNTIME_KEY)) ?? '{}') as { runtimeId?: string };
    if (current.runtimeId === record.runtimeId) (await store.kvDelete(ACTIVE_RUNTIME_KEY));
  } catch {
    // Preserve malformed state for the next boot to diagnose.
  }
}

export async function runtimeAuditTrail(store: {
  auditRecentByActionPrefix(prefix: string, limit?: number): (Array<{ action?: string }>) | Promise<Array<{ action?: string }>>;
}, limit = 20) {
  return (await store.auditRecentByActionPrefix('runtime.', Math.max(1, limit)));
}
