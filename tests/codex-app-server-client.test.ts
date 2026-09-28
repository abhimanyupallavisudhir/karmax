import { describe, it, expect } from 'vitest';
import { PassThrough, Writable } from 'node:stream';
import { CodexAppServerClient } from '../src/agent/codex-app-server-client.js';

/**
 * Unit tests for the codex app-server JSON-RPC transport (SPEC §7.1): newline-
 * delimited framing, request/response correlation, server-request auto-response,
 * notification fan-out. No real `codex` binary — a PassThrough feeds server lines
 * and a capturing Writable records what the client sends.
 */
function harness(maxLineBytes?: number) {
  const stdout = new PassThrough();
  const sent: any[] = [];
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      for (const line of chunk.toString().split('\n')) if (line.trim()) sent.push(JSON.parse(line));
      cb();
    },
  });
  const client = new CodexAppServerClient(stdin, stdout, maxLineBytes);
  const feed = (obj: unknown) => stdout.write(JSON.stringify(obj) + '\n');
  return { client, sent, feed, stdout };
}

describe('CodexAppServerClient', () => {
  it.each([false, true])('rejects oversized protocol lines (fragmented=%s)', async (fragmented) => {
    const { client, stdout } = harness(128);
    const result = client.request('initialize', {});
    const rejected = expect(result).rejects.toThrow(/line exceeds/);
    if (fragmented) {
      for (let n = 0; n < 70; n++) stdout.write('é');
    } else stdout.write('x'.repeat(129) + '\n');
    // A later valid response must not rescue a transport that exceeded its cap.
    stdout.write('{"id":1,"result":{}}\n');
    await rejected;
    await expect(client.request('thread/start', {})).rejects.toThrow(/closed/);
  });

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

  it('receives a large fragmented response without starving the control plane', async () => {
    const parse = async (bytes: number) => {
      const { client, stdout } = harness();
      const pending = client.request('thread/resume', {});
      const content = 'x'.repeat(bytes);
      const wire = JSON.stringify({ id: 1, result: { content } }) + '\n';
      const started = performance.now();
      for (let offset = 0; offset < wire.length; offset += 4096)
        stdout.write(wire.slice(offset, offset + 4096));
      const received = (await pending).content;
      const elapsed = performance.now() - started;
      expect(received).toBe(content);
      client.close();
      return elapsed;
    };
    const fastest = async (bytes: number) => {
      let best = Infinity;
      for (let run = 0; run < 3; run++) best = Math.min(best, await parse(bytes));
      return best;
    };
    // The former parser rescanned the whole accumulated line on every chunk, so
    // four times the bytes cost about sixteen times as long and a large response
    // blocked health checks and cloud keep-alives for seconds. A linear parser
    // costs about four times as long. Comparing the fastest of three runs at two
    // sizes measures that growth on any runner, where a fixed time bound mostly
    // measures the runner.
    const small = await fastest(2 * 1024 * 1024);
    const large = await fastest(8 * 1024 * 1024);
    expect(large / small).toBeLessThan(8);
  });

  it('preserves UTF-8 characters split across stdout buffers', () => {
    const { client, stdout } = harness();
    const got: any[] = [];
    client.onNotification((_method, params) => got.push(params));
    const wire = Buffer.from(JSON.stringify({ method: 'message', params: 'हैलो 🌍' }) + '\n');
    for (const byte of wire) stdout.write(Buffer.from([byte]));
    expect(got).toEqual(['हैलो 🌍']);
    client.close();
  });

  it('ignores late output and the rest of a batch after closing', () => {
    const { client, stdout } = harness();
    const got: string[] = [];
    client.onNotification((method) => { got.push(method); client.close(); });
    stdout.write('{"method":"first"}\n{"method":"second"}\n');
    stdout.write('{"method":"late"}\n');
    expect(got).toEqual(['first']);
  });

  it('turns an asynchronous stdin EPIPE into a request rejection instead of an uncaught process error', async () => {
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    const client = new CodexAppServerClient(stdin, stdout);
    const p = client.request('turn/start', {});

    // Real child stdin sockets emit this asynchronously; emit() would throw and
    // fail the whole test process if the transport had no error listener.
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    expect(() => stdin.emit('error', epipe)).not.toThrow();
    await expect(p).rejects.toThrow(/transport failed: write EPIPE/);
    await expect(client.request('thread/start', {})).rejects.toThrow(/closed/);
  });

  it('rejects pending requests when app-server stdout disappears before child close', async () => {
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    const client = new CodexAppServerClient(stdin, stdout);
    const p = client.request('initialize', {});
    stdout.end();
    await expect(p).rejects.toThrow(/stdout ended/);
  });
});
