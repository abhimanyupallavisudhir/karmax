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
  kvGet(key: string): string | undefined;
  kvSet(key: string, value: string): unknown;
  kvDelete(key: string): void;
  appendAudit(entry: {
    ts?: number;
    principalId: string;
    action: string;
    scopeKey?: string;
    detail?: Record<string, unknown>;
  }): number;
}

const audit = (store: RuntimeLifecycleStore, action: string, at: number, detail: Record<string, unknown>) =>
  store.appendAudit({ ts: at, principalId: 'system:runtime', action, scopeKey: 'global', detail });

/** Persist incarnation boundaries outside container logs. If the active marker
 * survives, the prior process never reached its graceful shutdown path; the next
 * boot turns that absence into an explicit, queryable incident. */
export function beginRuntimeLifecycle(store: RuntimeLifecycleStore, record: RuntimeRecord): RuntimeRecord {
  const raw = store.kvGet(ACTIVE_RUNTIME_KEY);
  if (raw) {
    try {
      const previous = JSON.parse(raw) as Record<string, unknown>;
      if (previous.runtimeId !== record.runtimeId) {
        audit(store, 'runtime.previous-unclean', record.startedAt, { previous, detectedBy: record.runtimeId });
      }
    } catch {
      audit(store, 'runtime.previous-unclean', record.startedAt, { previous: { malformed: true }, detectedBy: record.runtimeId });
    }
  }
  store.kvSet(ACTIVE_RUNTIME_KEY, JSON.stringify(record));
  audit(store, 'runtime.started', record.startedAt, { ...record });
  return record;
}

export function endRuntimeLifecycle(
  store: RuntimeLifecycleStore,
  record: RuntimeRecord,
  stop: { stoppedAt: number; reason: string; restart: boolean },
): void {
  audit(store, 'runtime.stopped', stop.stoppedAt, {
    runtimeId: record.runtimeId,
    reason: stop.reason,
    restart: stop.restart,
    uptimeMs: Math.max(0, stop.stoppedAt - record.startedAt),
  });
  // Never erase a newer incarnation's marker during overlapping supervisor handoff.
  try {
    const current = JSON.parse(store.kvGet(ACTIVE_RUNTIME_KEY) ?? '{}') as { runtimeId?: string };
    if (current.runtimeId === record.runtimeId) store.kvDelete(ACTIVE_RUNTIME_KEY);
  } catch {
    // Preserve malformed state for the next boot to diagnose.
  }
}

export function runtimeAuditTrail(store: {
  auditRecentByActionPrefix(prefix: string, limit?: number): Array<{ action?: string }>;
}, limit = 20) {
  return store.auditRecentByActionPrefix('runtime.', Math.max(1, limit));
}
