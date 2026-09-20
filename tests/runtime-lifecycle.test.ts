import { describe, expect, it } from 'vitest';
import { beginRuntimeLifecycle, endRuntimeLifecycle } from '../src/util/runtime-lifecycle.js';

describe('durable runtime lifecycle diagnostics', () => {
  it('records an unclean predecessor and closes the current incarnation', async () => {
    const kv = new Map<string, string>();
    const audit: any[] = [];
    const store = {
      kvGet: (key: string) => kv.get(key),
      kvSet: (key: string, value: string) => kv.set(key, value),
      kvDelete: (key: string) => { kv.delete(key); },
      appendAudit: (entry: any) => { audit.push(entry); return audit.length; },
      auditRecentByActionPrefix: (prefix: string, limit = 100) =>
        audit.filter((entry) => entry.action.startsWith(prefix)).slice(-limit),
    };
    kv.set('runtime:active', JSON.stringify({ runtimeId: 'old', startedAt: 10, pid: 1 }));

    const run = (await beginRuntimeLifecycle(store, {
      runtimeId: 'new', startedAt: 20, pid: 2, version: '1.0.0', buildRevision: 'abc', node: 'v22',
    }));
    expect(audit.map((entry) => entry.action)).toEqual([
      'runtime.previous-unclean', 'runtime.started',
    ]);
    expect(audit[0].detail.previous).toMatchObject({ runtimeId: 'old', pid: 1 });

    (await endRuntimeLifecycle(store, run, { stoppedAt: 30, reason: 'SIGTERM', restart: true }));
    expect(audit.at(-1)).toMatchObject({ action: 'runtime.stopped', detail: { runtimeId: 'new', reason: 'SIGTERM', restart: true } });
    expect(kv.has('runtime:active')).toBe(false);
  });
});
