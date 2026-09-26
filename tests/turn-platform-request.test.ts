import { afterEach, describe, expect, it, vi } from 'vitest';
import { turnPlatformRequest } from '../src/agent/platform-request.js';

const options = { token: 'test-token', method: 'GET', path: '/api/tasks/t' };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('turn gateway response bounds', () => {
  it('cancels a response stream as soon as its body exceeds 2 MiB', async () => {
    const cancel = vi.fn();
    // The pre-fix implementation buffers the entire response; provide a finite
    // oversized response there so the regression fails without exhausting RAM.
    let chunks = 0;
    const finite = new ReadableStream({ pull(controller) {
      if (++chunks <= 4) controller.enqueue(new Uint8Array(1024 * 1024));
      else controller.close();
    }, cancel });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(finite)));
    await expect(turnPlatformRequest(options)).rejects.toThrow('exceeds 2 MiB');
    expect(cancel).toHaveBeenCalled();
  });

  it('propagates turn cancellation to an outstanding request', async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => { requestSignal = init.signal; return new Response('{}'); }));
    await turnPlatformRequest({ ...options, signal: controller.signal });
    controller.abort();
    expect(requestSignal?.aborted).toBe(true);
  });

  it('gives every request a finite deadline', async () => {
    const deadline = vi.spyOn(AbortSignal, 'timeout');
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => { requestSignal = init.signal; return new Response('{}'); }));
    await turnPlatformRequest(options);
    expect(requestSignal).toBeInstanceOf(AbortSignal);
    expect(deadline).toHaveBeenCalledWith(30_000);
  });
});
