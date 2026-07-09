import { describe, it, expect } from 'vitest';
import { PassThrough, Writable } from 'node:stream';
import { CodexAppServerClient } from '../src/agent/codex-app-server-client.js';

/**
 * Unit tests for the codex app-server JSON-RPC transport (SPEC §7.1): newline-
 * delimited framing, request/response correlation, server-request auto-response,
 * notification fan-out. No real `codex` binary — a PassThrough feeds server lines
 * and a capturing Writable records what the client sends.
 */
function harness() {
  const stdout = new PassThrough();
  const sent: any[] = [];
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      for (const line of chunk.toString().split('\n')) if (line.trim()) sent.push(JSON.parse(line));
      cb();
    },
  });
  const client = new CodexAppServerClient(stdin, stdout);
  const feed = (obj: unknown) => stdout.write(JSON.stringify(obj) + '\n');
  return { client, sent, feed, stdout };
}

describe('CodexAppServerClient', () => {
  it('correlates a response to its request by id and resolves the result', async () => {
    const { client, sent, feed } = harness();
    const p = client.request('thread/start', { cwd: '/w' });
    expect(sent[0]).toMatchObject({ id: 1, method: 'thread/start', params: { cwd: '/w' } });
    feed({ id: 1, result: { thread: { id: 'th_1' } } });
    expect(await p).toEqual({ thread: { id: 'th_1' } });
  });

  it('rejects a request when the server returns an error', async () => {
    const { client, feed } = harness();
    const p = client.request('turn/start', {});
    feed({ id: 1, error: { code: -32600, message: 'Invalid request' } });
    await expect(p).rejects.toThrow(/Invalid request/);
  });

  it('routes a server request through onServerRequest and writes the handler result', async () => {
    const { client, sent, feed } = harness();
    const seen: string[] = [];
    client.onServerRequest((method) => { seen.push(method); return { decision: 'approved_for_session' }; });
    feed({ id: 7, method: 'execCommandApproval', params: { command: ['rm'] } });
    await new Promise((r) => setTimeout(r, 5)); // handler is async
    expect(seen).toEqual(['execCommandApproval']);
    expect(sent.find((m) => m.id === 7)).toEqual({ id: 7, result: { decision: 'approved_for_session' } });
  });

  it('always answers a server request (defaults to {} when the handler returns nothing)', async () => {
    const { client, sent, feed } = harness();
    client.onServerRequest(() => undefined);
    feed({ id: 9, method: 'currentTime/read', params: {} });
    await new Promise((r) => setTimeout(r, 5));
    expect(sent.find((m) => m.id === 9)).toEqual({ id: 9, result: {} });
  });

  it('fans out notifications (no id) to onNotification', async () => {
    const { client, feed } = harness();
    const events: Array<[string, any]> = [];
    client.onNotification((method, params) => events.push([method, params]));
    feed({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
    feed({ method: 'item/agentMessage/delta', params: { delta: 'hi' } });
    await new Promise((r) => setTimeout(r, 5));
    expect(events).toEqual([
      ['turn/completed', { turn: { status: 'completed' } }],
      ['item/agentMessage/delta', { delta: 'hi' }],
    ]);
  });

  it('reassembles messages split across chunks and splits several in one chunk', async () => {
    const { client, stdout } = harness();
    const got: any[] = [];
    client.onNotification((m, p) => got.push([m, p]));
    const p = client.request('initialize', {});
    // response arrives in two writes, split mid-JSON…
    stdout.write('{"id":1,"resu');
    stdout.write('lt":{"ok":true}}\n');
    // …then two notifications in a single chunk.
    stdout.write('{"method":"a","params":1}\n{"method":"b","params":2}\n');
    expect(await p).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 5));
    expect(got).toEqual([['a', 1], ['b', 2]]);
  });

  it('rejects in-flight requests on close', async () => {
    const { client } = harness();
    const p = client.request('thread/start', {});
    client.close();
    await expect(p).rejects.toThrow(/closed/);
  });
});
