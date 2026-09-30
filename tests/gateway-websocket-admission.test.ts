import { expect, it } from 'vitest';
import WebSocket from 'ws';
import { stubGateway } from './helpers/stub-gateway.js';

function connect(url: string, headers?: Record<string, string>) {
  const ws = new WebSocket(url, { headers });
  return { ws, result: new Promise<'open' | 'rejected'>(resolve => {
    ws.once('open', () => resolve('open')); ws.once('error', () => resolve('rejected'));
  }) };
}
it('authenticates and checks Origin before upgrading WebSockets (GW-9)', async () => {
  const h = await stubGateway();
  const sockets: WebSocket[] = [];
  try {
    const url = h.base.replace('http:', 'ws:') + '/ws';
    const anonymous = connect(url); sockets.push(anonymous.ws);
    expect(await anonymous.result).toBe('rejected');
    const token = (await h.tokens.mintPrincipal('user:test', ['*'])).token;
    const foreign = connect(url, { authorization: `Bearer ${token}`, origin: 'https://evil.example' }); sockets.push(foreign.ws);
    expect(await foreign.result).toBe('rejected');
    const valid = connect(url, { authorization: `Bearer ${token}` }); sockets.push(valid.ws);
    expect(await valid.result).toBe('open');
    const closed = new Promise<number>(resolve => valid.ws.once('close', resolve));
    valid.ws.send('x'.repeat(5000));
    expect(await closed).toBe(1009);
  } finally { for (const ws of sockets) ws.terminate(); await h.close(); }
});

it('bounds concurrent sockets per principal (GW-9)', async () => {
  const h = await stubGateway(); const sockets: WebSocket[] = [];
  try {
    const token = (await h.tokens.mintPrincipal('user:test', ['*'])).token;
    for (let n = 0; n < 33; n++) {
      const connection = connect(h.base.replace('http:', 'ws:') + '/ws', { authorization: `Bearer ${token}` });
      sockets.push(connection.ws);
      expect(await connection.result).toBe(n < 32 ? 'open' : 'rejected');
    }
  } finally { for (const ws of sockets) ws.terminate(); await h.close(); }
});
