import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { fillCardInWorld, type CardFillDetails, type CardFillSelectors } from '../src/autonomy/card-fill.js';
import { fakeBrowser, type FakePage } from './helpers/fake-browser.js';

describe('remote secure card fill', () => {
  it('passes PAN/CVC only on stdin — never argv, env, or output', async () => {
    const exec = vi.fn(async (_cmd: string, argv: string[], options: any) => {
      expect(argv.slice(0, 2)).toEqual(['--input-type=module', '-e']);
      expect(argv.join(' ')).not.toContain('4242424242424242');
      expect(argv.join(' ')).not.toContain('123');
      // The environment is NOT a safe channel, which this test used to assert it
      // was: ContainerWorld.exec turns `env` into `-e KEY=VALUE` argv for
      // `docker exec`, putting the full PAN and CVC in the HOST's process argv
      // (readable by any local user via ps), and any co-resident process in the
      // world can read /proc/<pid>/environ for the helper's whole lifetime.
      const env = JSON.stringify(options.env ?? {});
      expect(env).not.toContain('4242424242424242');
      expect(env).not.toContain('123');
      // Only non-secret routing config travels in the environment.
      expect(options.env).toMatchObject({ KARMAX_CARD_DOMAIN: 'shop.example' });
      // The secrets arrive on stdin, the same channel world-fill.ts uses.
      expect(JSON.parse(options.input)).toMatchObject({ number: '4242424242424242', cvc: '123' });
      return { code: 0, stdout: JSON.stringify({ origin: 'https://checkout.shop.example' }), stderr: '' };
    });
    const result = await fillCardInWorld({ exec } as any, {
      cdpUrl: 'http://127.0.0.1:9222',
      domain: 'shop.example',
      selectors: { number: '@focused', expiry: '@tab', cvc: '@tab' },
      details: { number: '4242424242424242', cvc: '123', expMonth: 12, expYear: 2030 },
    });
    expect(result).toEqual({ origin: 'https://checkout.shop.example' });
    expect(JSON.stringify(result)).not.toContain('4242424242424242');
    expect(exec).toHaveBeenCalledOnce();
  });

  /**
   * Moving the PAN out of argv/env and onto stdin created a second way for it to
   * escape: the in-world helper parsed its stdin with a bare `JSON.parse`, and V8
   * embeds a fragment of the offending input in `SyntaxError.message`
   * (`Unexpected token 'b', "ber":"4242"... is not valid JSON`). That goes to the
   * helper's stderr, and `fillCardInWorld` splices stderr into the error it
   * throws — which is logged and shown in the UI. A truncated or partially
   * delivered stdin (E2B streams `sendStdin`, Daytona uploads a file) is exactly
   * how that happens in production, so this runs the REAL helper source under a
   * lossy stdin and checks the digits never make it into the thrown message.
   */
  it('never leaks card digits through a stdin JSON parse error', async () => {
    let stderr = '';
    let truncated = '';
    const lossyWorld = {
      exec: async (_cmd: string, argv: string[], options: any) => {
        // Simulate a lost first chunk: the tail alone is not valid JSON, but it
        // still holds the whole PAN.
        truncated = String(options.input).slice(5);
        const child = spawnSync(process.execPath, argv, {
          input: truncated,
          env: { ...process.env, ...options.env },
          encoding: 'utf8',
        });
        stderr = child.stderr;
        return { code: child.status ?? 1, stdout: child.stdout, stderr: child.stderr };
      },
    };
    const error = await fillCardInWorld(lossyWorld as any, {
      cdpUrl: 'http://127.0.0.1:9222',
      domain: 'shop.example',
      selectors: { number: '@focused', expiry: '@tab', cvc: '@tab' },
      details: { number: '4242424242424242', cvc: '123', expMonth: 12, expYear: 2030 },
    }).then(() => undefined, (e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect(truncated).toContain('4242424242424242'); // the lossy stdin really did carry the PAN
    // Neither the helper's own stderr nor the error karmax logs may echo the input.
    for (const text of [stderr, error!.message]) {
      // Every 4-digit window of the PAN, plus the shape of the payload itself.
      // (A bare /\d{4}/ would trip on the digits in the task-world path that
      // Node prints in the stack trace.)
      expect(text).not.toContain('4242');
      expect(text).not.toContain('2424');
      expect(text).not.toContain('"cvc"');
    }
    // …and the failure is still reported, with a fixed, input-independent reason.
    expect(error!.message).toMatch(/card fill failed/i);
    expect(stderr).toMatch(/not valid JSON/i);
  });
});

/** A world that runs the helper as a real process on this host, the way a
 * sandbox runs it next to its own browser. Asynchronous, so the fake browser in
 * this process can answer it. */
const hostWorld = {
  exec: (cmd: string, argv: string[], options: { env?: Record<string, string>; input?: string; timeoutMs?: number }) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(cmd === 'node' ? process.execPath : cmd, argv, { env: { ...process.env, ...options.env }, timeout: options.timeoutMs });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
      child.stdin.end(options.input ?? '');
    }),
};

const card: CardFillDetails = { number: '4242424242424242', cvc: '123', expMonth: 3, expYear: 2031 };

async function fillIn(pages: FakePage[], selectors: CardFillSelectors, details = card, domain = 'shop.example') {
  const browser = await fakeBrowser(pages);
  try {
    const result: { value?: Awaited<ReturnType<typeof fillCardInWorld>>; error?: Error } = await fillCardInWorld(hostWorld as any,
      { cdpUrl: browser.url, domain, selectors, details }).then((value) => ({ value }), (error: Error) => ({ error }));
    return { ...result, values: pages.map((_page, index) => browser.values(index)), calls: browser.calls };
  } finally {
    await browser.close();
  }
}

// The in-world helper is a string the host never executes, so coverage of
// card-fill.ts says nothing about it. These run it for real (CI-38e).
describe('in-world card fill helper', () => {
  const checkout: FakePage = { url: 'https://pay.shop.example/checkout', fields: ['#number', '#expiry', '#cvc'] };

  it('types each detail into its own field and reports the verified origin', async () => {
    const { value, values } = await fillIn([checkout], { number: '#number', expiry: '#expiry', cvc: '#cvc' });
    expect(value).toEqual({ origin: 'https://pay.shop.example' });
    expect(values[0]).toEqual({ '#number': '4242424242424242', '#expiry': '03/31', '#cvc': '123' });
  });

  it('follows focus controls through fields it cannot select, like a cross-origin card iframe', async () => {
    const { value, values } = await fillIn([checkout], { number: '@focused', expiry: '@tab', cvc: '@tab' });
    expect(value?.origin).toBe('https://pay.shop.example');
    expect(values[0]).toEqual({ '#number': '4242424242424242', '#expiry': '03/31', '#cvc': '123' });
  });

  it('fills separate month and year fields with a zero-padded month and the full year', async () => {
    const page = { url: 'https://shop.example/pay', fields: ['#cc', '#mm', '#yy', '#cvv'] };
    const { values } = await fillIn([page], { number: '#cc', expMonth: '#mm', expYear: '#yy', cvc: '#cvv' });
    expect(values[0]).toEqual({ '#cc': '4242424242424242', '#mm': '03', '#yy': '2031', '#cvv': '123' });
  });

  it('fills billing fields only where the form asks and the card has a value', async () => {
    const page = { url: 'https://shop.example/pay', fields: ['#cc', '#exp', '#cvc', '#street', '#city', '#zip', '#country'] };
    const { values } = await fillIn([page],
      { number: '#cc', expiry: '#exp', cvc: '#cvc', line1: '#street', postalCode: '#zip', country: '#country' },
      { ...card, billing: { line1: '1 Main St', city: 'Springfield', postalCode: '12345' } });
    expect(values[0]).toEqual({ '#cc': '4242424242424242', '#exp': '03/31', '#cvc': '123',
      '#street': '1 Main St', '#city': '', '#zip': '12345', '#country': '' });
  });

  it('fills the checkout tab even when another tab comes first', async () => {
    const { value, values } = await fillIn([{ url: 'https://docs.example.org/guide', fields: ['#search'] }, checkout],
      { number: '#number', expiry: '#expiry', cvc: '#cvc' });
    expect(value).toEqual({ origin: 'https://pay.shop.example' });
    expect(values[0]).toEqual({ '#search': '' });
    expect(values[1]).toMatchObject({ '#number': '4242424242424242' });
  });

  it.each([
    ['another site', { url: 'https://shop.example.evil.test/checkout' }],
    ['a lookalike domain', { url: 'https://evilshop.example/checkout' }],
    ['a target list that lies', { url: 'https://pay.shop.example/checkout', origin: 'https://evil.test' }],
  ])('types nothing into %s', async (_name, page) => {
    const { error, values, calls } = await fillIn([{ ...page, fields: ['#number', '#expiry', '#cvc'] }],
      { number: '#number', expiry: '#expiry', cvc: '#cvc' });
    expect(error?.message).toMatch(/secure card fill failed in the task world: [\s\S]*(does not match reserved merchant|no browser page for the reserved merchant)/);
    expect(values[0]).toEqual({ '#number': '', '#expiry': '', '#cvc': '' });
    expect(calls.some((call) => call.method.startsWith('Input.'))).toBe(false);
    expect(error?.message).not.toContain('4242');
  });

  it('stops at a selector that matches nothing, without echoing the card', async () => {
    const { error, values } = await fillIn([checkout], { number: '#number', expiry: '#exp-date', cvc: '#cvc' });
    expect(error?.message).toMatch(/checkout field selector did not match/);
    expect(error?.message).not.toContain('4242');
    expect(values[0]).toEqual({ '#number': '4242424242424242', '#expiry': '', '#cvc': '' });
  });

  it('only talks to a loopback browser', async () => {
    const error = await fillCardInWorld(hostWorld as any, { cdpUrl: 'http://example.com:9222', domain: 'shop.example',
      selectors: { number: '@focused', expiry: '@tab', cvc: '@tab' }, details: card }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/CDP endpoint must be loopback inside the task world/);
    // IPv6 loopback is loopback: nothing listens there, but it is not refused.
    const v6 = await fillCardInWorld(hostWorld as any, { cdpUrl: 'http://[::1]:1', domain: 'shop.example',
      selectors: { number: '@focused', expiry: '@tab', cvc: '@tab' }, details: card }).catch((e: Error) => e);
    expect((v6 as Error).message).not.toMatch(/must be loopback/);
  });

  it('will not send the card to a debugger socket off the loopback', async () => {
    const browser = await fakeBrowser([checkout]);
    const remote = http.createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify([{ type: 'page', url: checkout.url, webSocketDebuggerUrl: `ws://localhost.example.com:${browser.port}/devtools/page/0` }]));
    });
    await new Promise<void>((resolve) => remote.listen(0, '127.0.0.1', resolve));
    try {
      const error = await fillCardInWorld(hostWorld as any, { cdpUrl: `http://127.0.0.1:${(remote.address() as AddressInfo).port}`,
        domain: 'shop.example', selectors: { number: '@focused', expiry: '@tab', cvc: '@tab' }, details: card }).catch((e: Error) => e);
      expect((error as Error).message).toMatch(/browser page target must be a loopback websocket/);
      expect(browser.calls).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => remote.close(() => resolve()));
      await browser.close();
    }
  });
});

describe('card fill result handling', () => {
  const args = { cdpUrl: 'http://127.0.0.1:9222', domain: 'shop.example', selectors: { number: '@focused', cvc: '@tab', expiry: '@tab' }, details: card };
  it.each([
    [{ code: 0, stdout: 'not json', stderr: '' }, 'secure card fill returned an invalid result'],
    [{ code: 0, stdout: '{"filled":true}', stderr: '' }, 'secure card fill did not verify a browser origin'],
    [{ code: 1, stdout: '', stderr: `  ${'x'.repeat(600)}  ` }, `secure card fill failed in the task world: ${'x'.repeat(500)}`],
  ])('rejects %j', async (result, message) => {
    const error = await fillCardInWorld({ exec: async () => result } as any, args).catch((e: Error) => e);
    expect((error as Error).message).toBe(message);
  });
});
