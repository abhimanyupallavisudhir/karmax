import { beforeEach, expect, it, vi } from 'vitest';
import type { TemporalConn } from '../src/temporal/config.js';

const mocks = { makeWorker: vi.fn() };
import { WorkerManager } from '../src/temporal/worker-pool.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function worker() {
  const completion = deferred<void>();
  return {
    run: vi.fn(() => completion.promise),
    shutdown: vi.fn(() => completion.resolve()),
  };
}
beforeEach(() => mocks.makeWorker.mockReset());
function managerWithControlledBuild() {
  const manager = new WorkerManager({} as TemporalConn);
  vi.spyOn(manager as unknown as { build(): Promise<ReturnType<typeof worker>> }, 'build')
    .mockImplementation(() => mocks.makeWorker());
  return manager;
}

it('drains a worker whose initial build completes after shutdown starts', async () => {
  const build = deferred<ReturnType<typeof worker>>();
  const handle = worker();
  mocks.makeWorker.mockReturnValue(build.promise);
  const manager = managerWithControlledBuild();
  const starting = manager.start();
  let stopped = false;
  const stopping = manager.stop().then(() => { stopped = true; });
  await expect(manager.refresh([])).rejects.toThrow('stopping');
  await expect(manager.start()).rejects.toThrow('stopping');
  expect(stopped).toBe(false);
  build.resolve(handle);
  await Promise.all([starting, stopping]);
  expect(handle.run).toHaveBeenCalledTimes(1);
  expect(handle.shutdown).toHaveBeenCalledTimes(1);
  await manager.stop();
  expect(handle.shutdown).toHaveBeenCalledTimes(1);
});

it('finishes accepted refreshes and drains the last handle without admitting another', async () => {
  const initial = worker();
  const next = worker();
  const last = worker();
  const build = deferred<ReturnType<typeof worker>>();
  mocks.makeWorker.mockResolvedValueOnce(initial).mockReturnValueOnce(build.promise).mockResolvedValueOnce(last);
  const manager = managerWithControlledBuild();
  await manager.start();
  const refresh = manager.refresh([]);
  const queued = manager.refresh([]);
  const stopping = manager.stop();
  await expect(manager.refresh([])).rejects.toThrow('stopping');
  build.resolve(next);
  await Promise.all([refresh, queued, stopping, manager.stop()]);
  expect(mocks.makeWorker).toHaveBeenCalledTimes(3);
  for (const handle of [initial, next, last]) {
    expect(handle.run).toHaveBeenCalledTimes(1);
    expect(handle.shutdown).toHaveBeenCalledTimes(1);
  }
});

it('still stops the live worker when an accepted refresh build fails', async () => {
  const initial = worker();
  mocks.makeWorker.mockResolvedValueOnce(initial).mockRejectedValueOnce(new Error('build failed'));
  const manager = managerWithControlledBuild();
  await manager.start();
  const refresh = expect(manager.refresh([])).rejects.toThrow('build failed');
  await Promise.all([refresh, manager.stop()]);
  expect(initial.shutdown).toHaveBeenCalledTimes(1);
});
