import type { WebSocket } from 'ws';
import { onAuthorityChange, type AuthorityChange } from '../store/authorization-epoch.js';

/** Register disconnect cleanup before awaiting resource acquisition. */
export function socketLifetime(socket: WebSocket) {
  const cleanups = new Set<() => void>();
  let closed = socket.readyState !== 1;
  const close = () => {
    closed = true;
    for (const cleanup of cleanups) cleanup();
    cleanups.clear();
  };
  socket.once('close', close);
  socket.once('error', close);
  return {
    get closed() { return closed || socket.readyState !== 1; },
    close,
    add(cleanup: () => unknown) {
      let done = false;
      const run = () => {
        if (done) return;
        done = true;
        void Promise.resolve().then(cleanup).catch(error => console.warn('[websocket] cleanup failed:', error));
      };
      if (closed || socket.readyState !== 1) run();
      else cleanups.add(run);
    },
  };
}

/**
 * Close `socket` once `allowed` says no (#367 review item 12). A socket that
 * checks only when it connects outlives a revoked token, a removed member or
 * a narrowed grant for as long as it stays open: a terminal keeps its shell.
 * Decided again at once when this process commits a change `relevant` to the
 * socket (by default any), at most once a second after that, and every
 * `intervalMs` for changes another process or replica made. A check that
 * fails to run is not a refusal; the next one decides.
 *
 * `relevant` matters at scale: every agent turn ends by revoking its token,
 * and re-deciding every socket on each of those was the 2026-10 load test's
 * first wall. A socket re-decides for changes to what it stands on.
 */
export function keepAuthorized(socket: WebSocket, lifetime: ReturnType<typeof socketLifetime>,
  allowed: () => Promise<boolean>, options: { relevant?: (change: AuthorityChange) => boolean; intervalMs?: number;
    timeoutMs?: number; code?: number; reason?: string } = {}): void {
  const { relevant = () => true, intervalMs = 5_000, timeoutMs = 10_000, code = 4403, reason = 'access withdrawn' } = options;
  // A lookup that hangs must not pause every later check: it times out, and
  // like a lookup that fails, a timed-out check is not a refusal.
  const decide = () => new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(true), timeoutMs);
    timer.unref?.();
    allowed().then(resolve, () => resolve(true)).finally(() => clearTimeout(timer));
  });
  let running: Promise<void> | undefined;
  let again = false;
  // A close frame only starts a handshake the client may ignore: stop what the
  // socket drives at once, and cut it off if it does not answer.
  const withdraw = () => {
    lifetime.close();
    socket.close(code, reason);
    setTimeout(() => { if (socket.readyState !== socket.CLOSED) socket.terminate(); }, 1_000).unref?.();
  };
  const check = (): void => {
    if (running) { again = true; return; }
    running = (async () => {
      do {
        again = false;
        if (lifetime.closed) return;
        if (!(await decide()) && !lifetime.closed) { withdraw(); return; }
      } while (again);
    })().finally(() => { running = undefined; });
  };
  // A burst of changes is one check at once and one after it.
  let checkedAt = -Infinity;
  let trailing: ReturnType<typeof setTimeout> | undefined;
  const changed = (change: AuthorityChange) => {
    if (trailing || !relevant(change)) return;
    const wait = checkedAt + 1_000 - Date.now();
    if (wait <= 0) { checkedAt = Date.now(); check(); return; }
    trailing = setTimeout(() => { trailing = undefined; checkedAt = Date.now(); check(); }, wait);
    trailing.unref?.();
  };
  const timer = setInterval(check, intervalMs);
  timer.unref?.();
  const off = onAuthorityChange(changed);
  lifetime.add(() => { clearInterval(timer); if (trailing) clearTimeout(trailing); off(); });
}
