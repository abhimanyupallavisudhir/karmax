import { utf8Tail } from '../util/utf8-tail.js';
import type { SecretScrubber } from '../agent/activity.js';

export const EXECUTION_OUTPUT_BYTES = 200_000;

/** The task's scrubber, current as of the moment it is asked (SS-3). */
export interface OutputSecrets { refresh(): Promise<SecretScrubber> }

/** Execution output is a reconnect ring, not an archive. Keep one bounded write
 * in flight and one bounded pending tail; a noisy process cannot create a
 * promise/database request per chunk while storage is slow. Live delivery is
 * independent. Completion explicitly drains the ring before updating status.
 *
 * With `secrets`, every value the task received is scrubbed before it is
 * stored. Output arrives in arbitrary chunks, so a tail that could be the start
 * of a value is held back until more output arrives or the stream closes. */
export class ExecutionOutput {
  private pending = '';
  private running?: Promise<void>;
  private retry?: NodeJS.Timeout;
  private closing = false;
  private failure?: unknown;
  /** Characters at the end of `pending` held back as a possible partial secret. */
  private held = 0;

  constructor(private persist: (data: string) => Promise<unknown>,
    private onError: (error: unknown) => void = error => console.error('[execution] output persistence failed:', error),
    private secrets?: OutputSecrets) {}

  append(data: string): void {
    if (this.closing || !data) return;
    this.pending = utf8Tail(this.pending + utf8Tail(data, EXECUTION_OUTPUT_BYTES), EXECUTION_OUTPUT_BYTES);
    this.held = 0;
    if (!this.running && !this.retry) this.start();
  }

  private start(): void {
    this.failure = undefined;
    this.running = Promise.resolve().then(async () => {
      while (this.pending.length > this.held) {
        const scrubber = this.secrets ? await this.secrets.refresh() : undefined;
        const raw = this.pending;
        const end = scrubber && !this.closing ? scrubber.safeEnd(raw) : raw.length;
        if (end === 0) { this.held = raw.length; break; }
        this.pending = raw.slice(end);
        this.held = 0;
        const data = scrubber ? scrubber.scrub(raw.slice(0, end)) : raw;
        try { await this.persist(data); }
        catch (error) {
          this.pending = utf8Tail(raw.slice(0, end) + this.pending, EXECUTION_OUTPUT_BYTES);
          this.failure = error;
          try { this.onError(error); } catch { /* diagnostics cannot reject a stream callback */ }
          break;
        }
      }
    }).catch((error) => {
      // A scrubber that cannot be read stores nothing rather than plaintext.
      this.failure = error;
      try { this.onError(error); } catch { /* diagnostics cannot reject a stream callback */ }
    }).finally(() => {
      this.running = undefined;
      if (!this.closing && this.pending.length > this.held) {
        this.retry = setTimeout(() => { this.retry = undefined; this.start(); }, this.failure ? 1000 : 0);
        this.retry.unref();
      }
    });
  }

  /** Stop accepting output, cancel retry timers and flush accepted data. A
   * storage failure is returned to the owner, never an unhandled rejection. */
  async close(): Promise<void> {
    this.closing = true;
    this.held = 0;
    clearTimeout(this.retry);
    this.retry = undefined;
    do {
      if (!this.running && this.pending) this.start();
      await this.running;
      if (this.failure) throw this.failure;
    } while (this.pending || this.running);
  }
}
