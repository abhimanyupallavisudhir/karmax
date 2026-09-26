import { afterEach, expect, it, vi } from 'vitest';
import { Connection } from '@temporalio/client';
import { createServerHealthProbe } from '../src/temporal/dev-server.js';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it('reuses the watcher connection and closes it on stop (PS-15)', async () => {
  const conn = { workflowService: { describeNamespace: vi.fn().mockResolvedValue({}) }, close: vi.fn().mockResolvedValue(undefined) };
  const connect = vi.spyOn(Connection, 'connect').mockResolvedValue(conn as any);
  const probe = createServerHealthProbe('fixture:7233', 'default');
  expect(await probe.check()).toBe(true);
  expect(await probe.check()).toBe(true);
  expect(connect).toHaveBeenCalledTimes(1);
  await probe.close();
  expect(conn.close).toHaveBeenCalledTimes(1);
  expect(await probe.check()).toBe(false);
});

it('closes a connection that arrives after the probe timed out and stopped (PS-15)', async () => {
  vi.useFakeTimers();
  let resolve!: (connection: Connection) => void;
  vi.spyOn(Connection, 'connect').mockReturnValue(new Promise(done => { resolve = done; }));
  const conn = { close: vi.fn().mockResolvedValue(undefined) };
  const probe = createServerHealthProbe('fixture:7233', 'default');
  const checking = probe.check();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await checking).toBe(false);
  await probe.close();
  resolve(conn as any);
  await vi.advanceTimersByTimeAsync(0);
  expect(conn.close).toHaveBeenCalledTimes(1);
});
