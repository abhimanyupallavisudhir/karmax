import { describe, it, expect } from 'vitest';
import net from 'node:net';
import { findFreePort, findFreePortFrom, findFreePorts, isPortFree, waitForPort } from '../src/util/ports.js';

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
});
