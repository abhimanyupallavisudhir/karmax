import { randomUUID } from 'node:crypto';
import { TimingTrace, type TimingContext, type TimingRow } from './index.js';

/** One bounded, ephemeral receipt per turn/attempt per websocket. A client can
 * acknowledge only evidence actually sent to that socket. No caller timestamps,
 * task ids or content are accepted. This is frame opportunity, not proof of paint. */
export class TimingDelivery {
  private seen = new Set<string>();
  private pending = new Map<string, { trace: TimingTrace; end: Awaited<ReturnType<TimingTrace['start']>>; at: number }>();
  constructor(private sink: (row: TimingRow) => unknown, private enabled: () => boolean | Promise<boolean> = () => true,
    private traceFactory?: (context: TimingContext, sink: (row: TimingRow) => unknown) => TimingTrace | Promise<TimingTrace>) {}
  async offer(context: TimingContext) {
    if (!(await this.enabled()) || !context.turnId) return undefined;
    const key = `${context.taskId}/${context.workflowRunId}/${context.turnId}/${context.attempt}`;
    if (this.seen.has(key)) return undefined;
    this.seen.add(key);
    if (this.seen.size > 512) this.seen.delete(this.seen.values().next().value!);
    const trace = (await this.traceFactory?.(context, this.sink)) ?? new TimingTrace(context, this.sink, undefined, undefined, this.enabled);
    const id = randomUUID();
    if (this.pending.size >= 256) this.pending.delete(this.pending.keys().next().value!);
    this.pending.set(id, { trace, end: (await trace.start('delivery.socket-roundtrip')), at: performance.now() });
    return id;
  }
  async acknowledge(input: unknown) {
    if (!(await this.enabled())) { this.pending.clear(); return; }
    if (!input || typeof input !== 'object') return;
    const value = input as Record<string, unknown>;
    if (value.type !== 'timing.frame' || typeof value.id !== 'string' || typeof value.frameMs !== 'number'
      || !Number.isFinite(value.frameMs) || value.frameMs < 0 || value.frameMs > 600_000) return;
    const pending = this.pending.get(value.id);
    if (!pending) return;
    this.pending.delete(value.id);
    if (performance.now() - pending.at > 600_000) return;
    (await pending.end());
    (await pending.trace.mark('delivery.browser-frame', { browserFrameMs: value.frameMs }));
  }
}
