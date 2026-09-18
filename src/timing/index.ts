import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/** Sparse, content-free observations. Wall clocks order distributed evidence;
 * only values with the same clockId may be subtracted as monotonic durations. */
export interface TimingContext {
  taskId: string;
  turnId?: string;
  workflowRunId?: string;
  attempt?: number;
  requestIds?: string[];
  role?: string;
}
export interface TimingMetadata {
  provider?: string;
  model?: string;
  sessionMode?: 'fresh' | 'resumed' | 'forked';
  worldKind?: string;
  systemPromptChars?: number;
  transcriptChars?: number;
  messageCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  inputTokensIncludeCacheRead?: boolean;
  operation?: string;
  itemId?: string;
  requestId?: string;
  scheduleToStartWallEstimateMs?: number;
  browserFrameMs?: number;
}
export interface TimingRow extends TimingContext {
  version: 1;
  id: string;
  traceId: string;
  clockId: string;
  wallMs: number;
  monoMs: number;
  name: string;
  phase: 'start' | 'end' | 'mark';
  spanId?: string;
  durationMs?: number;
  status?: 'ok' | 'failed' | 'cancelled';
  metadata?: TimingMetadata;
}
const processClock = randomUUID();
const local = new AsyncLocalStorage<TimingTrace>();
export const currentTiming = () => { const trace = local.getStore(); return trace?.enabled() ? trace : undefined; };
export const withTiming = <T>(trace: TimingTrace, fn: () => T): T => trace.enabled() ? local.run(trace, fn) : local.getStore() ? local.exit(fn) : fn();
export const timed = <T>(name: string, fn: () => Promise<T>, metadata?: TimingMetadata, isFailure?: (value: T) => boolean): Promise<T> =>
  currentTiming()?.measure(name, fn, metadata, undefined, isFailure) ?? fn();

export class TimingTrace {
  readonly traceId: string;
  readonly clockId: string;
  private once = new Set<string>();
  /** Observes cancellation; does not cancel or alter the underlying operation. */
  signal?: AbortSignal;
  constructor(readonly context: TimingContext, private sink: (row: TimingRow) => void,
    private now: () => number = () => performance.now(), clockId?: string, private active: () => boolean = () => true) {
    this.traceId = this.enabled() ? randomUUID() : '';
    this.clockId = clockId ?? processClock;
  }
  enabled(): boolean {
    try { if (this.active()) return true; } catch { /* fail closed */ }
    this.active = () => false; return false;
  }
  private emit(name: string, phase: TimingRow['phase'], extra: Partial<TimingRow> = {}) {
    try {
      const row: TimingRow = { ...this.context, version: 1, id: randomUUID(), traceId: this.traceId,
        clockId: this.clockId, wallMs: Date.now(), monoMs: this.now(), name, phase, ...extra };
      this.sink(row);
      return row;
    } catch { this.active = () => false; return undefined; }
  }

  mark(name: string, metadata?: TimingMetadata, at?: { monoMs: number; wallMs: number }) { if (!this.enabled()) return; this.emit(name, 'mark', { metadata, ...at }); }
  markOnce(name: string, metadata?: TimingMetadata, key = name) {
    if (!this.enabled() || this.once.has(key)) return;
    this.once.add(key); this.mark(name, metadata);
  }
  start(name: string, metadata?: TimingMetadata): (status?: TimingRow['status'], finishMetadata?: TimingMetadata) => void {
    if (!this.enabled()) return () => {};
    const spanId = randomUUID(); const start = this.emit(name, 'start', { spanId, metadata });
    if (!start) return () => {};
    let ended = false;
    return (status: TimingRow['status'] = 'ok', finishMetadata?: TimingMetadata) => {
      if (ended || !this.enabled()) return; ended = true;
      try {
        const monoMs = this.now();
        this.emit(name, 'end', { spanId, monoMs, durationMs: Math.max(0, monoMs - start.monoMs), status,
          metadata: finishMetadata ?? metadata });
      } catch { this.active = () => false; }
    };
  }
  async measure<T>(name: string, fn: () => Promise<T>, metadata?: TimingMetadata, signal?: AbortSignal, isFailure?: (value: T) => boolean): Promise<T> {
    if (!this.enabled()) return fn();
    const end = this.start(name, metadata);
    const cancellation = signal ?? this.signal;
    try { const result = await fn(); end(cancellation?.aborted ? 'cancelled' : isFailure?.(result) ? 'failed' : 'ok'); return result; }
    catch (e) { end(cancellation?.aborted ? 'cancelled' : 'failed'); throw e; }
  }
}

/** Read shared persistent settings at each boundary, including across worker processes. */
export function timingEnabled(store?: { getSettings(scope: string, key: string): Record<string, unknown> | undefined }): boolean {
  try { return store?.getSettings('global', 'timing')?.enabled === true; } catch { return false; }
}
export function installationTiming(store: Parameters<typeof timingEnabled>[0], context: TimingContext, sink: (row: TimingRow) => void): TimingTrace {
  let snapshot: Record<string, unknown> | undefined;
  try { snapshot = store?.getSettings('global', 'timing'); } catch { /* fail closed */ }
  return new TimingTrace(context, sink, undefined, undefined, () => {
    if (snapshot?.enabled !== true) return false;
    const current = store?.getSettings('global', 'timing');
    return current?.enabled === true && current.revision === snapshot.revision;
  });
}

export function distribution(samples: (number | null)[]) {
  const values = samples.filter((n): n is number => n !== null && Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  const n = values.length;
  return { count: n, missing: samples.length - n,
    medianMs: n ? (values[Math.floor((n - 1) / 2)]! + values[Math.floor(n / 2)]!) / 2 : null,
    p95Ms: n ? values[Math.ceil(n * .95) - 1]! : null };
}
export function unionMs(intervals: [number, number][]) {
  let total = 0, end = -Infinity;
  for (const [a, b] of [...intervals].sort((x, y) => x[0] - y[0])) {
    if (b > Math.max(a, end)) total += b - Math.max(a, end);
    end = Math.max(end, b);
  }
  return total;
}

export function timingReport(input: TimingRow[]) {
  const rows = [...new Map(input.filter(r => r?.version === 1).map(r => [r.id, r])).values()];
  const groups = new Map<string, TimingRow[]>();
  for (const r of rows) { const key = r.traceId; groups.set(key, [...(groups.get(key) ?? []), r]); }
  const attempts = [...groups.values()].flatMap(ownGroup => {
    const group = [...ownGroup];
    const root = group.find(r => r.name === 'agent.attempt' && r.phase === 'start');
    if (!root) return [];
    if (root.turnId && root.attempt !== undefined) group.push(...rows.filter(r => r.traceId !== root.traceId
      && r.taskId === root.taskId && r.turnId === root.turnId && r.workflowRunId === root.workflowRunId && r.attempt === root.attempt && r.clockId === root.clockId));
    const ends = new Map(group.filter(r => r.phase === 'end').map(r => [r.spanId, r]));
    const finish = ends.get(root.spanId);
    const starts = group.filter(r => r.phase === 'start');
    const pairs = starts.flatMap(r => {
      const end = ends.get(r.spanId);
      return end && end.clockId === r.clockId && end.monoMs >= r.monoMs ? [{ start: r, end }] : [];
    });
    const first = (name: string) => {
      const mark = group.find(r => r.name === name && r.clockId === root.clockId);
      return mark && mark.monoMs >= root.monoMs ? mark.monoMs - root.monoMs : null;
    };
    const totalMs = finish?.durationMs ?? null;
    const childPairs = pairs.filter(p => p.start.spanId !== root.spanId);
    const coveredMs = finish ? unionMs(childPairs.map(p => [Math.max(root.monoMs, p.start.monoMs),
      Math.min(finish.monoMs, p.end.monoMs)] as [number, number]).filter(([a, b]) => b >= a)) : null;
    const names = [...new Set(childPairs.map(p => p.start.name))];
    const external = root.turnId && root.attempt !== undefined ? rows.filter(r => r.taskId === root.taskId
      && r.turnId === root.turnId && r.workflowRunId === root.workflowRunId && r.attempt === root.attempt
      && r.clockId !== root.clockId) : [];
    const externalEnds = new Map(external.filter(r => r.phase === 'end').map(r => [r.spanId, r]));
    const externalSpans = external.filter(r => r.phase === 'start').map(start => ({
      name: start.name, spanId: start.spanId, clockId: start.clockId,
      durationMs: externalEnds.get(start.spanId)?.durationMs ?? null,
      status: externalEnds.get(start.spanId)?.status ?? 'incomplete',
    }));
    return [{ taskId: root.taskId, turnId: root.turnId, workflowRunId: root.workflowRunId, attempt: root.attempt, traceId: root.traceId,
      requestIds: root.requestIds ?? [], status: group.some(r => r.name === 'provider.interrupted') ? 'interrupted' : finish?.status ?? 'incomplete',
      metadata: Object.assign({}, ...ownGroup.filter(r => ['adapter.invoked', 'provider.selected', 'provider.completed', 'activity.started'].includes(r.name)).map(r => r.metadata ?? {})) as TimingMetadata,
      totalMs, firstTextMs: first('first.text'), firstOutputMs: first('first.output'), firstProviderEventMs: first('provider.first-event'), coveredMs,
      unattributedMs: totalMs !== null && coveredMs !== null ? Math.max(0, totalMs - coveredMs) : null,
      externalSpans,
      openSpans: starts.filter(r => !ends.has(r.spanId)).length,
      spans: names.map(name => { const ps = childPairs.filter(p => p.start.name === name);
        return { name, count: ps.length, sumMs: ps.reduce((s, p) => s + (p.end.durationMs ?? 0), 0),
          unionMs: unionMs(ps.map(p => [p.start.monoMs, p.end.monoMs])) }; }),
    }];
  });
  // End-to-end linkage is explicit. Never pair a follow-up with text that was
  // emitted before the adapter even observed it. Follow-ups inside a live turn
  // have receipt/offer evidence but no invented per-message completion.
  const requests = rows.filter(r => r.name === 'request.received').map(receipt => {
    const id = receipt.metadata?.requestId;
    const candidates = rows.filter(r => r.requestIds?.includes(id ?? ''));
    const text = candidates.find(r => r.name === 'first.text');
    const complete = candidates.find(r => r.name === 'agent.attempt' && r.phase === 'end' && r.status === 'ok'
      && !rows.some(m => m.traceId === r.traceId && m.name === 'provider.interrupted'));
    const elapsed = (end: TimingRow | undefined) => !end ? null : end.clockId === receipt.clockId
      ? end.monoMs >= receipt.monoMs ? end.monoMs - receipt.monoMs : null : null;
    const started = candidates.find(r => r.name === 'agent.attempt' && r.phase === 'start');
    const endBySpan = new Map(rows.filter(r => r.phase === 'end').map(r => [r.spanId, r]));
    const breakdown = (boundary: TimingRow | undefined) => {
      if (!boundary || boundary.clockId !== receipt.clockId) return null;
      const measured = rows.filter(r => r.taskId === receipt.taskId && r.clockId === receipt.clockId
        && r.phase === 'start' && r.name !== 'agent.attempt'
        && (r.requestIds?.includes(id ?? '') || r.turnId && r.turnId === boundary.turnId && r.workflowRunId === boundary.workflowRunId
          || !r.turnId && r.name === 'world.prepare'))
        .flatMap(start => {
          const end = endBySpan.get(start.spanId);
          if (!end || end.clockId !== start.clockId) return [];
          const a = Math.max(receipt.monoMs, start.monoMs), b = Math.min(boundary.monoMs, end.monoMs);
          return b > a ? [{ name: start.name, interval: [a, b] as [number, number] }] : [];
        });
      const coveredMs = unionMs(measured.map(m => m.interval));
      return { coveredMs, unattributedMs: Math.max(0, boundary.monoMs - receipt.monoMs - coveredMs),
        spans: [...new Set(measured.map(m => m.name))].map(name => {
          const selected = measured.filter(m => m.name === name);
          return { name, count: selected.length, unionMs: unionMs(selected.map(m => m.interval)),
            sumMs: selected.reduce((n, m) => n + m.interval[1] - m.interval[0], 0) };
        }) };
    };
    return { requestId: id, taskId: receipt.taskId, firstTextMs: elapsed(text), completionMs: elapsed(complete), preActivityMs: elapsed(started),
      firstResponseBreakdown: breakdown(text), completionBreakdown: breakdown(complete),
      firstTextWallEstimateMs: text ? text.wallMs - receipt.wallMs : null,
      completionWallEstimateMs: complete ? complete.wallMs - receipt.wallMs : null,
      clockBasis: 'monotonic-only; cross-process wall estimates are separate' };
  });
  const spanStarts = rows.filter(r => r.phase === 'start');
  const spanEnds = new Map(rows.filter(r => r.phase === 'end').map(r => [r.spanId, r]));
  const intervals = [...new Set(spanStarts.map(r => r.name))].map(name => {
    const starts = spanStarts.filter(r => r.name === name);
    return { name, ...distribution(starts.map(r => spanEnds.get(r.spanId)?.durationMs ?? null)),
      failed: starts.filter(r => spanEnds.get(r.spanId)?.status === 'failed').length,
      cancelled: starts.filter(r => spanEnds.get(r.spanId)?.status === 'cancelled').length };
  });
  const queueRows = rows.filter(r => r.name.startsWith('queue.observed.') || r.name.startsWith('account.wait.observed.'));
  const queueIntervals = queueRows.filter(r => r.name === 'queue.observed.waiting-slot' || r.name === 'account.wait.observed.start').map(start => {
    const end = queueRows.slice(queueRows.indexOf(start) + 1).find(r => r.taskId === start.taskId && r.workflowRunId === start.workflowRunId &&
      (start.name.startsWith('account.') ? r.name === 'account.wait.observed.end'
        : r.turnId === start.turnId && r.name !== 'queue.observed.waiting-slot'));
    return { taskId: start.taskId, turnId: start.turnId, name: start.name,
      durationMs: end && end.clockId === start.clockId ? Math.max(0, end.monoMs - start.monoMs) : null,
      wallEstimateMs: end ? end.wallMs - start.wallMs : null,
      basis: 'publication-observed; includes workflow/activity dispatch, not exact coordinator residence' };
  });
  for (const start of rows.filter(r => r.name === 'queue.account.requested' || r.name === 'queue.slot.requested')) {
    const end = rows.slice(rows.indexOf(start) + 1).find(r => r.taskId === start.taskId && r.workflowRunId === start.workflowRunId && r.turnId === start.turnId
      && (start.name === 'queue.account.requested' ? r.name === 'queue.observed.waiting-slot'
        : r.name === 'agent.attempt' && r.phase === 'start'));
    queueIntervals.push({ taskId: start.taskId, turnId: start.turnId, name: start.name,
      durationMs: end && end.clockId === start.clockId ? Math.max(0, end.monoMs - start.monoMs) : null,
      wallEstimateMs: end ? end.wallMs - start.wallMs : null,
      basis: 'request-to-publication/activity; includes scheduling, not exact coordinator residence' });
  }
  const cohortGroups = new Map<string, typeof attempts>();
  for (const a of attempts) {
    const key = JSON.stringify([a.metadata.provider ?? null, a.metadata.model ?? null, a.metadata.sessionMode ?? null,
      a.metadata.worldKind ?? null, a.attempt === 1 ? 'initial' : 'retry']);
    cohortGroups.set(key, [...(cohortGroups.get(key) ?? []), a]);
  }
  const cohorts = [...cohortGroups].map(([key, values]) => ({
    dimensions: JSON.parse(key), attempts: values.length,
    firstResponse: distribution(values.map(a => a.firstTextMs)),
    completion: distribution(values.map(a => a.status === 'ok' ? a.totalMs : null)),
  }));
  const frames = new Map(rows.filter(r => r.name === 'delivery.browser-frame').map(r => [r.traceId, r.metadata?.browserFrameMs]));
  const browserFrame = distribution(rows.filter(r => r.name === 'delivery.socket-roundtrip' && r.phase === 'start')
    .map(r => frames.get(r.traceId) ?? null));
  return { version: 1, attempts, requests, intervals, queueIntervals, cohorts, browserFrame,
    cohortDimensions: ['provider', 'model', 'sessionMode', 'worldKind', 'initialOrRetry'],
    firstResponse: distribution(attempts.map(a => a.firstTextMs)),
    completion: distribution(attempts.map(a => a.status === 'ok' ? a.totalMs : null)),
    requestFirstResponse: distribution(requests.map(r => r.firstTextMs)),
    requestCompletion: distribution(requests.map(r => r.completionMs)),
    requestFirstResponseWallEstimate: distribution(requests.filter(r => r.firstTextMs === null).map(r => r.firstTextWallEstimateMs)),
    requestCompletionWallEstimate: distribution(requests.filter(r => r.completionMs === null).map(r => r.completionWallEstimateMs)),
    notes: ['Attempt durations begin at activity execution, not user receipt.',
      'Span sums overlap; use unionMs. Unattributed time is not model inference.',
      'CLI/provider intervals include opaque startup, queueing, inference and transport.',
      'Missing or interrupted spans are unknown. No browser render or network delivery is inferred.'],
    observations: rows };
}

/** MCP/application errors can be successful HTTP/RPC transports. */
export function toolFailed(value: unknown): boolean {
  return !!value && typeof value === 'object' &&
    (('isError' in value && value.isError === true) || ('successful' in value && value.successful === false));
}
