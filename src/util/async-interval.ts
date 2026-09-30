/** A periodic asynchronous job has at most one invocation in flight. Missed
 * ticks coalesce; shutdown can await the final invocation before closing its
 * database/client dependencies. Errors are observed rather than escaping a
 * timer callback as an unhandled rejection. */
export class AsyncInterval {
  private timer: NodeJS.Timeout;
  private running?: Promise<void>;
  private again?: Promise<void>;
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
  /** Run now, or once more as soon as the invocation in flight settles: a
   * wake-up that arrives mid-run may concern work that run has already passed
   * (#396 review item 9). Wake-ups during one run coalesce into one rerun. */
  wake(): Promise<void> {
    if (!this.running) return this.run();
    return this.again ??= this.running.then(() => { this.again = undefined; return this.run(); });
  }
  unref(): this { this.timer.unref(); return this; }
  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.running;
  }
}
