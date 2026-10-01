import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { stubGateway } from './helpers/stub-gateway.js';

/**
 * A browser's event socket can die without a close: a laptop sleeps, a phone
 * changes network, a NAT forgets the flow. Browsers cannot see protocol pings,
 * so the console asks with an application `ping` and treats a missing `pong` as
 * a dead socket (reconnect + backfill). The gateway, in turn, pings each socket
 * and drops one that stopped answering instead of streaming into the void.
 */
afterEach(() => { vi.useRealTimers(); });

async function connect() {
  const h = await stubGateway();
  const token = (await h.tokens.mintPrincipal('user:test', ['*'])).token;
  vi.spyOn(h.gateway as any, 'socketAuth').mockResolvedValue({ apiToken: token });
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const ws = Object.assign(new EventEmitter(), {
    readyState: 1, bufferedAmount: 0, send: vi.fn(), close: vi.fn(), ping: vi.fn(),
    terminate: vi.fn(() => { ws.readyState = 3; ws.emit('close'); }),
  });
  await (h.gateway as any).eventStream(ws, { headers: {}, url: '/ws' });
  const sent = () => ws.send.mock.calls.map(([data]) => JSON.parse(String(data)).type);
  return { h, ws, sent };
}

it('answers an application ping so the console can tell its socket is alive', async () => {
  const { h, ws, sent } = await connect();
  try {
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'ping' })));
    await vi.waitFor(() => expect(sent()).toContain('pong'));
  } finally { ws.emit('close'); await h.close(); }
});

it('drops a socket that stops answering protocol pings', async () => {
  const { h, ws } = await connect();
  try {
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ws.ping).toHaveBeenCalledTimes(1);
    ws.emit('pong');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ws.ping).toHaveBeenCalledTimes(2);
    expect(ws.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ws.terminate).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ws.ping).toHaveBeenCalledTimes(2);
  } finally { await h.close(); }
});
