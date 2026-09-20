import { afterEach, expect, it, vi } from 'vitest';
import { AsyncInterval } from '../src/util/async-interval.js';

afterEach(() => vi.useRealTimers());
it('coalesces ticks while busy and drains the active job on stop', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const job = vi.fn(() => blocked);
  const interval = new AsyncInterval(job, 10);
  await vi.advanceTimersByTimeAsync(100);
  expect(job).toHaveBeenCalledTimes(1);
  let stopped = false;
  const stopping = interval.stop().then(() => { stopped = true; });
  await Promise.resolve();
  expect(stopped).toBe(false);
  release();
  await stopping;
  await vi.advanceTimersByTimeAsync(100);
  expect(job).toHaveBeenCalledTimes(1);
});
it('observes failures and permits the next tick to retry', async () => {
  vi.useFakeTimers();
  const error = new Error('unavailable');
  const job = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
  const failed = vi.fn();
  const interval = new AsyncInterval(job, 10, failed);
  await vi.advanceTimersByTimeAsync(20);
  await interval.stop();
  expect(failed).toHaveBeenCalledExactlyOnceWith(error);
  expect(job).toHaveBeenCalledTimes(2);
});

it('shares a boot invocation with timer ticks and refuses new work after stop', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const job = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
  const interval = new AsyncInterval(job, 10);
  const boot = interval.run();
  expect(interval.run()).toBe(boot);
  await vi.advanceTimersByTimeAsync(100);
  expect(job).toHaveBeenCalledTimes(1);
  const stopping = interval.stop();
  await interval.run();
  release();
  await stopping;
  await interval.run();
  expect(job).toHaveBeenCalledTimes(1);
});
