import net from 'node:net';

/**
 * Dynamic port allocation. karmax never hardcodes localhost ports: every
 * service (Temporal gRPC/UI, the gateway) asks for a free port at boot.
 */

/** Ask the OS for a free TCP port by binding to :0 and reading it back. */
export function findFreePort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
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
 * Find a free port at or above `preferred`, walking upward one port at a time.
 * Unlike `findFreePort` (which asks the OS for an arbitrary free port), this
 * prefers a conventional port so a service's URL stays stable across restarts
 * (SPEC: the gateway tries 4505, stepping up only if it's taken). Falls back to
 * an OS-assigned port if the whole window is occupied.
 */
export async function findFreePortFrom(preferred: number, host = '127.0.0.1', maxTries = 100): Promise<number> {
  const start = Math.max(1, Math.min(65535, Math.floor(preferred)));
  for (let port = start; port < start + maxTries && port <= 65535; port++) {
    if (await isPortFree(port, host)) return port;
  }
  return findFreePort(host);
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
