import type { WebSocket } from 'ws';

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
