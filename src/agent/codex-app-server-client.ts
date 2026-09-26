import { ProviderStreamError } from './limits.js';
import type { Writable, Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

/**
 * Minimal JSON-RPC client for the `codex app-server` protocol (SPEC §7.1). The
 * app-server speaks newline-delimited JSON over stdio — one JSON object per line:
 *   • responses  `{ id, result }` / `{ id, error }`
 *   • requests   `{ id, method, params }`  (server → client, e.g. approvals)
 *   • notifs     `{ method, params }`       (streamed events)
 * (No `jsonrpc: "2.0"` envelope field — the codex protocol omits it.)
 *
 * This is the transport only: request/response correlation, server-request
 * auto-response, and notification fan-out. The adapter drives the session on top.
 * Factored out (and stream-based, not process-based) so it is unit-testable
 * without spawning the real binary.
 */
export class CodexAppServerClient {
  private fragments: string[] = [];
  private fragmentBytes = 0;
  private readonly decoder = new StringDecoder('utf8');
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private notificationHandler?: (method: string, params: any) => void;
  private serverRequestHandler?: (method: string, params: any) => any | Promise<any>;
  private closed = false;

  constructor(
    private readonly stdin: Writable,
    stdout: Readable,
    private readonly maxLineBytes = 64 * 1024 * 1024,
  ) {
    stdout.on('data', (d: Buffer | string) => {
      if (!this.closed) this.onData(typeof d === 'string' ? d : this.decoder.write(d));
    });
    // Writable failures are normally reported asynchronously through the stream's
    // `error` event (a write to a child that just exited is the classic EPIPE).
    // A try/catch around `.write()` cannot catch that event; without a listener,
    // Node treats it as an uncaught exception and terminates the entire karmax
    // gateway/worker process. Collapse every transport failure into the ordinary
    // request-rejection path instead.
    stdin.on('error', (e) => this.failTransport(e));
    stdout.on('error', (e) => this.failTransport(e));
    stdout.on('end', () => this.failTransport(new Error('codex app-server stdout ended')));
  }

  /** Register the streamed-event sink (turn/item lifecycle, deltas, errors). */
  onNotification(cb: (method: string, params: any) => void): void {
    this.notificationHandler = cb;
  }

  /** Register the handler for server→client requests (approvals). Its return value
   *  is sent back as the JSON-RPC result; throwing / undefined sends `{}`. Every
   *  server request MUST get a response or the server stalls waiting on it. */
  onServerRequest(cb: (method: string, params: any) => any | Promise<any> | Promise<any | Promise<any>>): void {
    this.serverRequestHandler = cb;
  }

  private onData(chunk: string): void {
    // PTYs deliver large responses (including native thread history) in small
    // chunks. Appending to and searching the entire accumulated string on each
    // chunk is quadratic and can starve HTTP, Temporal and sandbox heartbeats.
    // Search only new bytes; assemble each complete line once.
    let start = 0;
    for (;;) {
      const end = chunk.indexOf('\n', start);
      const tail = chunk.slice(start, end < 0 ? undefined : end);
      const bytes = Buffer.byteLength(tail);
      if (this.fragmentBytes + bytes > this.maxLineBytes || this.fragments.length >= 65_536) {
        this.failTransport(new Error('protocol line exceeds the bounded transport limit'));
        return;
      }
      if (end < 0) {
        if (tail) { this.fragments.push(tail); this.fragmentBytes += bytes; }
        return;
      }
      const line = this.fragments.length ? [...this.fragments, tail].join('') : tail;
      this.fragments = [];
      this.fragmentBytes = 0;
      if (line.trim()) this.handleLine(line);
      if (this.closed) return;
      start = end + 1;
    }
  }

  private handleLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // a non-JSON progress line — ignore
    }
    // A server→client request carries BOTH an id and a method.
    if (msg.id !== undefined && msg.method) {
      void this.handleServerRequest(msg.id, msg.method, msg.params);
      return;
    }
    // A response carries an id and no method.
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new ProviderStreamError(errorText(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    // Otherwise it's a notification.
    if (msg.method) this.notificationHandler?.(msg.method, msg.params);
  }

  private async handleServerRequest(id: number | string, method: string, params: any): Promise<void> {
    let result: any;
    try {
      result = this.serverRequestHandler ? await this.serverRequestHandler(method, params) : undefined;
    } catch {
      result = undefined;
    }
    this.writeLine({ id, result: result ?? {} });
  }

  /** Send a request; resolves with `result` or rejects with the server's error. */
  request<T = any>(method: string, params?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.closed) return reject(new Error('codex app-server client closed'));
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.writeLine({ id, method, params });
    });
  }

  /** Send a notification (no response expected). */
  notify(method: string, params?: unknown): void {
    this.writeLine(params === undefined ? { method } : { method, params });
  }

  private writeLine(obj: unknown): void {
    if (this.closed) return;
    try {
      // The callback catches failures delivered by Writable implementations that
      // don't emit `error`; the constructor listener catches the normal Socket
      // path. `failTransport` is idempotent, so seeing both is harmless.
      this.stdin.write(JSON.stringify(obj) + '\n', (err?: Error | null) => {
        if (err) this.failTransport(err);
      });
    } catch (e) {
      // Some synthetic/unit-test writables throw synchronously.
      this.failTransport(e);
    }
  }

  private failTransport(cause: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.fragments = [];
    this.fragmentBytes = 0;
    const detail = cause instanceof Error ? cause.message : String(cause);
    const error = new Error(`codex app-server transport failed: ${detail}`);
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
  }

  /** Reject any in-flight requests and stop writing. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.fragments = [];
    this.fragmentBytes = 0;
    for (const p of this.pending.values()) p.reject(new Error('codex app-server client closed'));
    this.pending.clear();
    try {
      this.stdin.end();
    } catch {
      /* ignore */
    }
  }
}

function errorText(error: any): string {
  if (error && typeof error === 'object') return `codex app-server error ${error.code ?? ''}: ${error.message ?? JSON.stringify(error)}`.trim();
  return `codex app-server error: ${String(error)}`;
}
