import { describe, it, expect } from 'vitest';
import { WorldOperationLock } from '../src/world/operation-lock.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

describe('world transition coordination', () => {
  it('serializes a world, permits recovery reentry and independent worlds, and releases after errors', async () => {
    const lock = new WorldOperationLock();
    const started = deferred(), finish = deferred();
    const events: string[] = [];
    const first = lock.run('one', async () => {
      await lock.run('one', async () => { events.push('recovery'); });
      started.resolve();
      await finish.promise;
      throw new Error('provider failed');
    });
    const rejected = expect(first).rejects.toThrow('provider failed');
    await started.promise;
    const second = lock.run('one', async () => { events.push('second'); });
    await lock.run('two', async () => { events.push('independent'); });
    expect(events).toEqual(['recovery', 'independent']);
    finish.resolve();
    await rejected;
    await second;
    expect(events).toEqual(['recovery', 'independent', 'second']);
  });

  it('does not let an escaped async context bypass a later owner', async () => {
    const lock = new WorldOperationLock();
    const escaped = deferred(), owner = deferred(), started = deferred();
    let background!: Promise<void>;
    let entered = false;
    await lock.run('one', async () => {
      background = escaped.promise.then(() => lock.run('one', async () => { entered = true; }));
    });
    const current = lock.run('one', async () => { started.resolve(); await owner.promise; });
    await started.promise;
    escaped.resolve();
    await new Promise(resolve => setImmediate(resolve));
    expect(entered).toBe(false);
    owner.resolve();
    await current;
    await background;
    expect(entered).toBe(true);
  });
});
