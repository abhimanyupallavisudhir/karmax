/** A periodic asynchronous job has at most one invocation in flight. Missed
 * ticks coalesce; shutdown can await the final invocation before closing its
 * database/client dependencies. Errors are observed rather than escaping a
 * timer callback as an unhandled rejection. */
export class AsyncInterval {
  private timer: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;

  constructor(operation: () => unknown, milliseconds: number,
    onError: (error: unknown) => void = error => console.error('[interval] job failed:', error)) {
    this.timer = setInterval(() => {
      if (this.stopped || this.running) return;
      this.running = Promise.resolve().then(operation).then(() => {}, error => {
        try { onError(error); } catch { /* a diagnostic must not reject the timer */ }
      }).finally(() => { this.running = undefined; });
    }, milliseconds);
  }
  unref(): this { this.timer.unref(); return this; }
  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.running;
  }
}
