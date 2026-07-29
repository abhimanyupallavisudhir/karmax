import { describe, it, expect } from 'vitest';
import net from 'node:net';
import { findFreePort, findFreePorts, findFreePortFrom, isPortFree, waitForPort } from '../src/util/ports.js';

function bind(port: number): Promise<net.Server> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}
const close = (srv: net.Server) => new Promise<void>((r) => srv.close(() => r()));

describe('dynamic port allocation', () => {
  it('finds a free port in the valid range', async () => {
    const port = await findFreePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
  });

  it('returns a port that is actually bindable', async () => {
    const port = await findFreePort();
    expect(await isPortFree(port)).toBe(true);
  });

  it('finds N distinct free ports', async () => {
    const ports = await findFreePorts(5);
    expect(ports).toHaveLength(5);
    expect(new Set(ports).size).toBe(5);
  });

  it('reports a bound port as not free', async () => {
    const port = await findFreePort();
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(port, '127.0.0.1', () => r()));
    try {
      expect(await isPortFree(port)).toBe(false);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it('findFreePortFrom returns the preferred port when it is free', async () => {
    const preferred = await findFreePort(); // free right now
    expect(await findFreePortFrom(preferred)).toBe(preferred);
  });

  it('findFreePortFrom walks upward when the preferred port is taken', async () => {
    const preferred = await findFreePort();
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(preferred, '127.0.0.1', () => r()));
    try {
      const port = await findFreePortFrom(preferred);
      expect(port).toBeGreaterThan(preferred);
      expect(await isPortFree(port)).toBe(true);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it('waitForPort resolves once a server is listening', async () => {
    const port = await findFreePort();
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(port, '127.0.0.1', () => r()));
    try {
      await expect(waitForPort(port, { timeoutMs: 2000 })).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it('waitForPort times out when nothing is listening', async () => {
    const port = await findFreePort(); // free, nothing listening
    await expect(waitForPort(port, { timeoutMs: 600, intervalMs: 100 })).rejects.toThrow(/timed out/);
  });

  it('findFreePortFrom returns the start port when it is free', async () => {
    const start = await findFreePort(); // known free
    expect(await findFreePortFrom(start)).toBe(start);
  });

  it('findFreePortFrom walks upward past a bound port to the next free one', async () => {
    const start = await findFreePort();
    const held = await bind(start); // start is now taken
    try {
      const got = await findFreePortFrom(start);
      expect(got).toBeGreaterThan(start);
      expect(await isPortFree(got)).toBe(true);
    } finally {
      await close(held);
    }
  });

  it('findFreePortFrom skips ports listed in avoid', async () => {
    const start = await findFreePort();
    const got = await findFreePortFrom(start, { avoid: [start] });
    expect(got).toBeGreaterThan(start);
  });

  it('findFreePortFrom throws when no port is free within maxTries', async () => {
    const start = await findFreePort();
    const held = await bind(start);
    try {
      await expect(findFreePortFrom(start, { maxTries: 1 })).rejects.toThrow(/no free port/);
    } finally {
      await close(held);
    }
  });

  it('findFreePort closes its server on the error path (no leaked handle)', async () => {
    // `srv.unref()` stops the socket holding the event loop open; it does NOT
    // release the handle. The `error` path used to reject and walk away, leaking
    // one server per failed attempt.
    const before = (process as any)._getActiveHandles?.().length ?? 0;
    for (let i = 0; i < 5; i++) {
      await expect(findFreePort('192.0.2.1')).rejects.toBeTruthy(); // TEST-NET-1: unbindable
    }
    await new Promise((r) => setTimeout(r, 50));
    const after = (process as any)._getActiveHandles?.().length ?? 0;
    expect(after).toBeLessThanOrEqual(before + 1);
  });
});
