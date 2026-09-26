import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { stubGateway } from './helpers/stub-gateway.js';

function socket() {
  const ws = Object.assign(new EventEmitter(), { readyState: 1, send: vi.fn(), close: vi.fn(), bufferedAmount: 0 });
  return { ws, disconnect() { ws.readyState = 3; ws.emit('close'); } };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

it('cleans timing subscriptions if the socket closes during initialization (PS-12)', async () => {
  const h = await stubGateway();
  try {
    const token = (await h.tokens.mintPrincipal('user:test', ['*'])).token;
    vi.spyOn(h.gateway as any, 'socketAuth').mockResolvedValue({ apiToken: token });
    const started = deferred<void>(); const resume = deferred<() => void>(); const off = vi.fn();
    vi.spyOn(h.gateway as any, 'watchTiming').mockImplementation(() => { started.resolve(); return resume.promise; });
    const { ws, disconnect } = socket();
    const streaming = (h.gateway as any).eventStream(ws, { headers: {}, url: '/ws' });
    await started.promise; disconnect(); resume.resolve(off); await streaming;
    expect(off).toHaveBeenCalledOnce();
  } finally { await h.close(); }
});

it('releases a preview world acquired after browser disconnect (PS-12)', async () => {
  const h = await stubGateway();
  try {
    const gateway = h.gateway as any;
    const handle = { id: 'w', kind: 'e2b', root: '/app', branch: 'task', base: 'main' };
    vi.spyOn(h.store, 'previewLease').mockResolvedValue({ id: 'lease', worldId: 'w', taskId: 't', generation: 1, port: 3000, expiresAt: Date.now() + 60_000 } as any);
    vi.spyOn(h.store, 'currentWorld').mockResolvedValue({ ...handle, generation: 1 } as any);
    vi.spyOn(h.store, 'getTask').mockResolvedValue({ id: 't', projectId: 'p', lastView: { world: handle } } as any);
    vi.spyOn(h.store, 'effectiveProjectConfig').mockResolvedValue({} as any);
    const token = (await h.tokens.mintPrincipal('user:test', ['*'])).token;
    vi.spyOn(gateway, 'auth').mockResolvedValue({ apiToken: token });
    const started = deferred<void>(); const resume = deferred<any>(); const release = vi.fn(async () => {});
    gateway.deps.worldAccess = { open: () => { started.resolve(); return resume.promise; } };
    const target = vi.fn(async () => ({ url: 'ws://127.0.0.1:1' }));
    const { ws, disconnect } = socket();
    const streaming = gateway.previewWebSocket(ws, { headers: {}, url: '/preview/lease/' });
    await started.promise; disconnect(); resume.resolve({ release, world: { previewSocketTarget: target } }); await streaming;
    expect(release).toHaveBeenCalledOnce();
    expect(target).not.toHaveBeenCalled();
  } finally { await h.close(); }
});
