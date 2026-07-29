import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { fillCardInWorld } from '../src/autonomy/card-fill.js';

describe('remote secure card fill', () => {
  it('passes PAN/CVC only on stdin — never argv, env, or output', async () => {
    const exec = vi.fn(async (_cmd: string, argv: string[], options: any) => {
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
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', argv[1]!], {
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
