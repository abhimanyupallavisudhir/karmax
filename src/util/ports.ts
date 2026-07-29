import net from 'node:net';

/**
 * Port allocation policy. Each karmax service has a conventional *default*
 * port and, at boot, claims the lowest free port at or above it (see
 * findFreePortFrom). So a service's URL is stable run-to-run — restarting
 * karmax (e.g. after editing its own code) reclaims the same port instead of
 * jumping to a fresh OS-assigned one — while a leftover or second instance
 * still starts cleanly on the next port up.
 *
 * findFreePort/findFreePorts (:0, arbitrary OS-chosen ports) remain for tests
 * that just need *some* free port and don't care which.
 */

/**
 * Find the lowest free TCP port at or above `start`, skipping any in `avoid`.
 * This is the default allocation strategy for karmax's long-lived services.
 */
export async function findFreePortFrom(
  start: number,
  { host = '127.0.0.1', maxTries = 512, avoid }: { host?: string; maxTries?: number; avoid?: Iterable<number> } = {},
): Promise<number> {
  const taken = new Set(avoid ?? []);
  const limit = Math.min(start + maxTries, 65536);
  for (let port = start; port < limit; port++) {
    if (taken.has(port)) continue;
    if (await isPortFree(port, host)) return port;
  }
  throw new Error(`no free port found at or above ${start} (tried up to ${limit - 1})`);
}

/** Ask the OS for a free TCP port by binding to :0 and reading it back.
 *
 *  The `error` path closes the server too. It used to reject and walk away,
 *  leaking a listening (or half-open) socket per failure — and `srv.unref()` only
 *  stops it holding the event loop open, it does not release the handle. A caller
 *  that retries in a loop (boot allocating several service ports) leaked one each
 *  time round. */
export function findFreePort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', (error) => {
      srv.close(() => reject(error));
    });
    srv.listen(0, host, () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('could not determine free port')));
      }
    });
  });
}

/**
 * Find `n` distinct free ports. We hold each socket open until all are found
 * so the OS does not hand us the same port twice, then release them.
 */
export async function findFreePorts(n: number, host = '127.0.0.1'): Promise<number[]> {
  const servers: net.Server[] = [];
  const ports: number[] = [];
  try {
    for (let i = 0; i < n; i++) {
      const { server, port } = await new Promise<{ server: net.Server; port: number }>(
        (resolve, reject) => {
          const srv = net.createServer();
          srv.unref();
          srv.on('error', reject);
          srv.listen(0, host, () => {
            const addr = srv.address();
            if (addr && typeof addr === 'object') resolve({ server: srv, port: addr.port });
            else reject(new Error('could not determine free port'));
          });
        },
      );
      servers.push(server);
      ports.push(port);
    }
    return ports;
  } finally {
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  }
}

/** True if `port` is currently bindable on `host`. */
export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}

/** Poll until a TCP port is accepting connections (a service has come up). */
export async function waitForPort(
  port: number,
  { host = '127.0.0.1', timeoutMs = 30_000, intervalMs = 200 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = net.connect({ port, host });
      sock.setTimeout(intervalMs);
      sock.once('connect', () => {
        sock.destroy();
        resolve(true);
      });
      sock.once('error', () => {
        sock.destroy();
        resolve(false);
      });
      sock.once('timeout', () => {
        sock.destroy();
        resolve(false);
      });
    });
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for port ${port} on ${host}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
