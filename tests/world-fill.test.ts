import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { fillInWorld } from '../src/autonomy/world-fill.js';
import { worldWorkingDirectory, type World, type WorldHandle } from '../src/world/types.js';

/** A stand-in World that records writeFile/exec calls; exec returns a canned result. */
function mockWorld(exec: (c: { cmd: string; args: string[]; opts: any }) => { stdout: string; stderr: string; code: number }) {
  const calls: { writes: { path: string; content: string }[]; execs: { cmd: string; args: string[]; opts: any }[] } = { writes: [], execs: [] };
  const world = {
    handle: { kind: 'e2b', id: 'fill', root: '/home/user/karmax', workdir: '/home/user/karmax/repo' },
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
    expect(ex.opts.cwd).toBe('/home/user/karmax');
    expect(JSON.stringify(ex.args)).not.toContain('S3CRET');
  });

  it('surfaces the helper error (e.g. anti-phishing origin mismatch) without leaking the secret', async () => {
    const { world } = mockWorld(() => ({ stdout: JSON.stringify({ error: 'refusing: origin mismatch' }), stderr: '', code: 1 }));
    await expect(fillInWorld(world, { selector: '#pw', expectDomains: ['evil.test'], cdpUrl: 'http://127.0.0.1:9222', resolveText: () => 'S3CRET' }))
      .rejects.toThrow(/origin mismatch/);
  });
});

/** A real local World honouring the provider contract: files are root-relative,
 * commands default to `workdir` (a single-repo world's nested checkout). */
function nestedWorld(root: string): World {
  const handle = { kind: 'memory', id: 'fill-nested', root, workdir: path.join(root, 'repo'), branch: 'b', base: 'main' } as WorldHandle;
  fs.mkdirSync(handle.workdir!, { recursive: true });
  return {
    handle,
    writeFile: async (rel: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    },
    exec: (cmd: string, args: string[], opts: any = {}) => new Promise((resolve) => {
      const child = spawn(cmd, args, { cwd: opts.cwd ?? worldWorkingDirectory(handle) });
      let stdout = '', stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
      child.stdin.end(opts.input ?? '');
    }),
  } as unknown as World;
}

describe('fillInWorld in a single-repo world (workdir nested under root)', () => {
  it('runs the helper it wrote, reaching the browser instead of failing to load', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-fill-'));
    // A DevTools endpoint with no pages: the helper must get far enough to ask it.
    const cdp = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end('[]'); });
    await new Promise<void>((resolve) => cdp.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = cdp.address() as AddressInfo;
      await expect(fillInWorld(nestedWorld(root), { selector: '#pw', expectDomains: ['www.amazon.co.uk'],
        cdpUrl: `http://127.0.0.1:${port}`, resolveText: () => 'S3CRET' }))
        .rejects.toThrow('no open page matches www.amazon.co.uk');
    } finally {
      cdp.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
