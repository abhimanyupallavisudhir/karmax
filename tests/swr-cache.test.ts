import { describe, it, expect } from 'vitest';
import { SwrCache } from '../src/util/swr-cache.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('SwrCache', () => {
  it('shares one load between concurrent readers', async () => {
    const gate = deferred<string>();
    let loads = 0;
    const cache = new SwrCache<string, string>(async () => { loads++; return gate.promise; }, 1000);
    const readers = [cache.get('org'), cache.get('org'), cache.get('org')];
    gate.resolve('catalog');
    expect((await Promise.all(readers)).map((entry) => entry.value)).toEqual(['catalog', 'catalog', 'catalog']);
    expect(loads).toBe(1);
  });

  it('answers from an expired value at once and refreshes it in the background', async () => {
    let now = 0;
    let version = 0;
    const next = deferred<void>();
    const cache = new SwrCache<string, number>(async () => {
      version++;
      if (version > 1) await next.promise;
      return version;
    }, 100, () => now);
    expect((await cache.get('org')).value).toBe(1);
    now = 500; // expired
    const stale = await cache.get('org');
    expect(stale.value).toBe(1); // no waiting on the slow reload
    next.resolve();
    await cache.refresh('org'); // joins the background reload
    expect((await cache.get('org')).value).toBe(2);
  });

  it('waits for a fresh load when asked to', async () => {
    let version = 0;
    const cache = new SwrCache<string, number>(async () => ++version, 60_000);
    expect((await cache.get('org')).value).toBe(1);
    expect((await cache.get('org')).value).toBe(1);
    expect((await cache.get('org', { fresh: true })).value).toBe(2);
  });

  it('does not cache a failed load, and a stale value survives a failed refresh', async () => {
    let now = 0;
    let fail = true;
    const cache = new SwrCache<string, string>(async () => {
      if (fail) throw new Error('provider offline');
      return 'ok';
    }, 100, () => now);
    await expect(cache.get('org')).rejects.toThrow('provider offline');
    fail = false;
    expect((await cache.get('org')).value).toBe('ok');
    fail = true;
    now = 1000;
    expect((await cache.get('org')).value).toBe('ok');
    await cache.refresh('org').catch(() => undefined);
    expect((await cache.get('org')).value).toBe('ok');
  });

  it('invalidation makes the next reader wait for current data', async () => {
    let inputs = 'before';
    const cache = new SwrCache<string, string>(async () => inputs, 60_000);
    expect((await cache.get('org')).value).toBe('before');
    inputs = 'after';
    cache.invalidate();
    expect((await cache.get('org')).value).toBe('after');
  });
});
