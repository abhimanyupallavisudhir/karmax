import { describe, it, expect } from 'vitest';
import { withTimeout } from '../src/util/timeout.js';

describe('withTimeout (bounds a live query so one wedged workflow cannot hang an endpoint)', () => {
  it('resolves when the promise settles in time', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000)).resolves.toBe('ok');
  });

  it('propagates a real rejection', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000)).rejects.toThrow('boom');
  });

  it('rejects (fast) when the promise never settles — the wedged-workflow case', async () => {
    const never = new Promise<string>(() => {}); // never resolves/rejects
    const t0 = Date.now();
    await expect(withTimeout(never, 120)).rejects.toThrow(/timed out/);
    expect(Date.now() - t0).toBeLessThan(1000); // bounded, didn't hang
  });

  it('models the getTaskView fallback: on timeout the caller uses its snapshot', async () => {
    const snapshot = { stage: 'review' };
    const hungQuery = new Promise(() => {});
    const view = await withTimeout(hungQuery, 100).catch(() => snapshot);
    expect(view).toBe(snapshot);
  });
});
