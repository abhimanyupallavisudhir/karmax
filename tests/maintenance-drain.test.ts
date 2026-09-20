import { afterEach, expect, it, vi } from 'vitest';
import { MailPoller } from '../src/autonomy/mail-pull.js';
import { DeliveryDispatcher } from '../src/collaboration/delivery.js';
import { WorldLifecycleManager } from '../src/world/runners.js';
import { WorldRegistry } from '../src/world/registry.js';
import { Store } from '../src/store/db.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('drains an in-flight mailbox lookup before shutdown completes', async () => {
  const blocked = deferred<[]>();
  const poller = new MailPoller({ readConfigs: () => blocked.promise,
    resolveSecret: () => undefined, store: {} as any, makeIngest: () => () => ({ delivered: false }) });
  const sweep = poller.sweep();
  let stopped = false;
  const stopping = poller.stop().then(() => { stopped = true; });
  await Promise.resolve();
  expect(stopped).toBe(false);
  blocked.resolve([]);
  expect(await sweep).toBe(0);
  await stopping;
});

it('observes mailbox database failures and retries on the next tick', async () => {
  vi.useFakeTimers();
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
  const readConfigs = vi.fn().mockRejectedValueOnce(new Error('database unavailable')).mockResolvedValue([]);
  const poller = new MailPoller({ readConfigs, resolveSecret: () => undefined,
    store: {} as any, makeIngest: () => () => ({ delivered: false }) }, 10);
  poller.start();
  await vi.advanceTimersByTimeAsync(20);
  await poller.stop();
  expect(readConfigs).toHaveBeenCalledTimes(2);
  expect(diagnostic).toHaveBeenCalledExactlyOnceWith('[mail] poll failed:', 'database unavailable');
});

it('drains a delivery claim before shutdown completes', async () => {
  const blocked = deferred<undefined>();
  const dispatcher = new DeliveryDispatcher({ claimDelivery: () => blocked.promise } as unknown as Store, {});
  const drain = dispatcher.drain();
  let stopped = false;
  const stopping = dispatcher.stop().then(() => { stopped = true; });
  await Promise.resolve();
  expect(stopped).toBe(false);
  blocked.resolve(undefined);
  expect(await drain).toBe(0);
  await stopping;
});

it('drains the active world sweep before its store can close', async () => {
  const store = await Store.create(':memory:');
  const entered = deferred<void>();
  const blocked = deferred<[]>();
  vi.spyOn(store, 'expiredPromotedArtifacts').mockImplementation(() => { entered.resolve(); return blocked.promise; });
  const lifecycle = new WorldLifecycleManager(store, new WorldRegistry(), {} as any);
  try {
    const sweep = lifecycle.sweep();
    await entered.promise;
    let stopped = false;
    const stopping = lifecycle.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    blocked.resolve([]);
    await sweep;
    await stopping;
  } finally { blocked.resolve([]); await lifecycle.stop(); await store.close(); }
});
