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
});
