/** A periodic asynchronous job has at most one invocation in flight. Missed
 * ticks coalesce; shutdown can await the final invocation before closing its
 * database/client dependencies. Errors are observed rather than escaping a
 * timer callback as an unhandled rejection. */
export class AsyncInterval {
  private timer: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;

  constructor(private operation: () => unknown, milliseconds: number,
    private onError: (error: unknown) => void = error => console.error('[interval] job failed:', error)) {
    this.timer = setInterval(() => { void this.run(); }, milliseconds);
  }
  /** Boot/manual invocation shares the same admission and shutdown boundary. */
  run(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.running ??= Promise.resolve().then(this.operation).then(() => {}, error => {
      try { this.onError(error); } catch { /* a diagnostic must not reject the timer */ }
    }).finally(() => { this.running = undefined; });
  }
  unref(): this { this.timer.unref(); return this; }
  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.running;
  }
}
