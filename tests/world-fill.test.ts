import { describe, it, expect } from 'vitest';
import { fillInWorld } from '../src/autonomy/world-fill.js';

/** A stand-in World that records writeFile/exec calls; exec returns a canned result. */
function mockWorld(exec: (c: { cmd: string; args: string[]; opts: any }) => { stdout: string; stderr: string; code: number }) {
  const calls: { writes: { path: string; content: string }[]; execs: { cmd: string; args: string[]; opts: any }[] } = { writes: [], execs: [] };
  const world = {
    writeFile: async (p: string, c: string) => { calls.writes.push({ path: p, content: c }); },
    exec: async (cmd: string, args: string[], opts: any) => { calls.execs.push({ cmd, args, opts }); return exec({ cmd, args, opts }); },
  } as any;
  return { world, calls };
}

describe('fillInWorld (remote-world credential fill)', () => {
  it('ships the helper, passes the secret via stdin (never argv), returns the verified origin', async () => {
    const { world, calls } = mockWorld(() => ({ stdout: JSON.stringify({ origin: 'https://demo.realworld.show' }), stderr: '', code: 0 }));
    const result = await fillInWorld(world, { selector: '#pw', expectDomains: ['demo.realworld.show'], cdpUrl: 'http://127.0.0.1:9222', resolveText: () => 'S3CRET' });
    expect(result.origin).toBe('https://demo.realworld.show');
    // the dep-free helper is written into the world
    expect(calls.writes[0]!.path).toMatch(/cdp-fill\.mjs$/);
    expect(calls.writes[0]!.content).toContain('Input.insertText');
    const ex = calls.execs[0]!;
    expect(ex.cmd).toBe('node');
    expect(ex.args).toEqual(['.karmax/cdp-fill.mjs', '#pw', 'demo.realworld.show', 'http://127.0.0.1:9222']);
    // the secret travels ONLY on stdin — never in argv
    expect(ex.opts.input).toBe('S3CRET');
    expect(JSON.stringify(ex.args)).not.toContain('S3CRET');
  });

  it('surfaces the helper error (e.g. anti-phishing origin mismatch) without leaking the secret', async () => {
    const { world } = mockWorld(() => ({ stdout: JSON.stringify({ error: 'refusing: origin mismatch' }), stderr: '', code: 1 }));
    await expect(fillInWorld(world, { selector: '#pw', expectDomains: ['evil.test'], cdpUrl: 'http://127.0.0.1:9222', resolveText: () => 'S3CRET' }))
      .rejects.toThrow(/origin mismatch/);
  });
});
