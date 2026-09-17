import { afterEach, describe, expect, it, vi } from 'vitest';
import dns from 'node:dns/promises';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { publicFetch } from '../src/mcp/connections/http.js';

afterEach(() => vi.restoreAllMocks());
describe('MCP public network boundary', () => {
  it('rejects a hostname with any private DNS answer before opening a socket', async () => {
    vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '1.1.1.1', family: 4 }, { address: '10.0.0.1', family: 4 }] as any);
    const socket = vi.spyOn(https, 'request');
    await expect(publicFetch('https://tools.example/mcp')).rejects.toThrow(/private/);
    expect(socket).not.toHaveBeenCalled();
  });
  function endpoint(status: number, body = '{}') {
    vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '1.1.1.1', family: 4 }] as any);
    return vi.spyOn(https, 'request').mockImplementation(((url: URL, options: any, callback: any) => {
      const req = new EventEmitter() as any;
      req.end = () => queueMicrotask(() => {
        const response = new PassThrough() as any;
        response.statusCode = status; response.headers = { 'content-type': 'application/json', ...(status === 302 ? { location: 'https://127.0.0.1/admin' } : {}) };
        req.destroy = (error: Error) => { response.destroy(); req.emit('error', error); req.emit('close'); };
        callback(response); response.end(body); queueMicrotask(() => req.emit('close'));
      });
      return req;
    }) as any);
  }
  it('pins the verified DNS answer at socket creation and supplies no ambient credentials', async () => {
    const socket = endpoint(200);
    expect(await (await publicFetch('https://tools.example/mcp')).json()).toEqual({});
    const options = socket.mock.calls[0]![1] as any;
    const lookup = vi.fn(); options.lookup('tools.example', {}, lookup);
    expect(lookup).toHaveBeenCalledWith(null, '1.1.1.1', 4);
    expect(options.headers).not.toHaveProperty('authorization');
    expect(options.headers).not.toHaveProperty('cookie');
    expect(dns.lookup).toHaveBeenCalledTimes(1);
  });
  it('never follows redirects, including redirects into the control plane', async () => {
    const socket = endpoint(302);
    await expect(publicFetch('https://tools.example/mcp')).rejects.toThrow(/redirect/);
    expect(socket).toHaveBeenCalledTimes(1);
  });
  it('rejects oversized responses', async () => {
    endpoint(200, 'x'.repeat(2 * 1024 * 1024 + 1));
    await expect(publicFetch('https://tools.example/mcp')).rejects.toThrow(/too large/);
  });
});
