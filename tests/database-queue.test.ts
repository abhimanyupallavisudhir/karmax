import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseQueue } from '../src/store/database-queue.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
afterEach(() => vi.useRealTimers());

it('removes expired requests, recovers capacity, and never executes their writes', async () => {
  vi.useFakeTimers();
  const queue = new DatabaseQueue({ maxPending: 2, waitTimeoutMs: 100 });
  const blocked = gate();
  const active = queue.enqueue(() => blocked.promise);
  const write = vi.fn(async () => {});
  const expired = expect(queue.enqueue(write)).rejects.toMatchObject({ status: 503, name: 'DatabaseQueueTimeoutError' });
  await expect(queue.enqueue(write)).rejects.toMatchObject({ name: 'DatabaseCapacityError' });
  await vi.advanceTimersByTimeAsync(100);
  await expired;
  expect(queue.pending).toBe(1);
  expect(queue.waiting).toBe(0);
  const retained = queue.enqueue(async () => 'committed');
  blocked.release();
  await active;
  expect(await retained).toBe('committed');
  expect(write).not.toHaveBeenCalled();
  expect(queue.pending).toBe(0);
  await queue.close();
});

it('does not time out an admitted write and clears its waiting deadline', async () => {
  vi.useFakeTimers();
  const queue = new DatabaseQueue({ waitTimeoutMs: 100 });
  const first = gate();
  const second = gate();
  const active = queue.enqueue(() => first.promise);
  const next = queue.enqueue(() => second.promise);
  await vi.advanceTimersByTimeAsync(90);
  first.release();
  await active;
  await vi.advanceTimersByTimeAsync(1_000);
  expect(queue.pending).toBe(1);
  second.release();
  await next;
  await queue.close();
});

it('preserves each caller context across serialized work and failures', async () => {
  const queue = new DatabaseQueue();
  const context = new AsyncLocalStorage<string>();
  const blocked = gate();
  const first = context.run('first', () => queue.enqueue(async () => {
    await blocked.promise;
    expect(context.getStore()).toBe('first');
    throw new Error('failed first');
  }));
  const failure = expect(first).rejects.toThrow('failed first');
  const second = context.run('second', () => queue.enqueue(async () => {
    await Promise.resolve();
    return context.getStore();
  }));
  blocked.release();
  await failure;
  expect(await second).toBe('second');
  expect(context.getStore()).toBeUndefined();
  await queue.close();
});

it('stops admission and drains accepted work when closing', async () => {
  const queue = new DatabaseQueue();
  const blocked = gate();
  const first = queue.enqueue(() => blocked.promise);
  const next = queue.enqueue(async () => 'saved');
  let closed = false;
  const closing = queue.close().then(() => { closed = true; });
  await expect(queue.enqueue(async () => {})).rejects.toThrow('closing');
  expect(closed).toBe(false);
  blocked.release();
  await first;
  expect(await next).toBe('saved');
  await closing;
  expect(closed).toBe(true);
  expect(queue.pending).toBe(0);
});
