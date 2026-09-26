import { describe, expect, it } from 'vitest';
import { acquireConfirmLock } from '../src/activities/confirm-lock.js';

describe('confirm turn lock', () => {
  it('removes an aborted waiter without blocking the following turn', async () => {
    const release = await acquireConfirmLock('queued');
    const controller = new AbortController();
    const reason = new Error('turn cancelled');
    const waiting = acquireConfirmLock('queued', controller.signal).then(() => 'acquired', error => error);
    const next = acquireConfirmLock('queued');
    controller.abort(reason);
    const outcome = await Promise.race([waiting, new Promise(resolve => setTimeout(() => resolve('still waiting'), 20))]);
    release();
    expect(outcome).toBe(reason);
    const releaseNext = await next;
    releaseNext();
    (await acquireConfirmLock('queued'))();
  });

  it('does not acquire a free lock after cancellation', async () => {
    const controller = new AbortController();
    controller.abort(new Error('already cancelled'));
    await expect(acquireConfirmLock('aborted', controller.signal)).rejects.toThrow('already cancelled');
    (await acquireConfirmLock('aborted'))();
  });
});
