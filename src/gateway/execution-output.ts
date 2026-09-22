import { utf8Tail } from '../util/utf8-tail.js';

export const EXECUTION_OUTPUT_BYTES = 200_000;

/** Execution output is a reconnect ring, not an archive. Keep one bounded write
 * in flight and one bounded pending tail; a noisy process cannot create a
 * promise/database request per chunk while storage is slow. Live delivery is
 * independent. Completion explicitly drains the ring before updating status. */
export class ExecutionOutput {
  private pending = '';
  private running?: Promise<void>;
  private retry?: NodeJS.Timeout;
  private closing = false;
  private failure?: unknown;

  constructor(private persist: (data: string) => Promise<unknown>,
    private onError: (error: unknown) => void = error => console.error('[execution] output persistence failed:', error)) {}

  append(data: string): void {
    if (this.closing || !data) return;
    this.pending = utf8Tail(this.pending + utf8Tail(data, EXECUTION_OUTPUT_BYTES), EXECUTION_OUTPUT_BYTES);
    if (!this.running && !this.retry) this.start();
  }

  private start(): void {
    this.failure = undefined;
    this.running = Promise.resolve().then(async () => {
      while (this.pending) {
        const data = this.pending;
        this.pending = '';
        try { await this.persist(data); }
        catch (error) {
          this.pending = utf8Tail(data + this.pending, EXECUTION_OUTPUT_BYTES);
          this.failure = error;
          try { this.onError(error); } catch { /* diagnostics cannot reject a stream callback */ }
          break;
        }
      }
    }).finally(() => {
      this.running = undefined;
      if (!this.closing && this.pending) {
        this.retry = setTimeout(() => { this.retry = undefined; this.start(); }, this.failure ? 1000 : 0);
        this.retry.unref();
      }
    });
  }

  /** Stop accepting output, cancel retry timers and flush accepted data. A
   * storage failure is returned to the owner, never an unhandled rejection. */
  async close(): Promise<void> {
    this.closing = true;
    clearTimeout(this.retry);
    this.retry = undefined;
    do {
      if (!this.running && this.pending) this.start();
      await this.running;
      if (this.failure) throw this.failure;
    } while (this.pending || this.running);
  }
}
