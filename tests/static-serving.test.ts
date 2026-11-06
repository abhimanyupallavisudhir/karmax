import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Gateway } from '../src/gateway/server.js';
import { consoleContentSecurityPolicy, preferredEncoding } from '../src/gateway/static-assets.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { WorldRegistry } from '../src/world/registry.js';
import { findFreePortFrom } from '../src/util/ports.js';

/**
 * The console has no build step, so the gateway itself is its asset server.
 * It used to answer every navigation with the full, uncompressed bundle
 * (app.js alone is over a megabyte) because `no-cache` had no validator to
 * revalidate against, and it let any site frame the console — a page of
 * one-click approvals. Boots a real Gateway with stub deps; no Temporal.
 */
describe('console static assets over HTTP', () => {
  let dir: string;
  let base: string;
  let close: () => Promise<void>;
  const appJs = 'export const line = "console asset";\n'.repeat(4000);

  /** node:http, not fetch: fetch decompresses transparently and hides the encoding. */
  function raw(pathname: string, headers: Record<string, string> = {}, method = 'GET') {
    return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      const req = http.request(`${base}${pathname}`, { method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-static-serving-'));
    fs.writeFileSync(path.join(dir, 'index.html'),
      '<!doctype html><html><head><title>krmax</title><meta name="description" content="x" /></head><body></body></html>');
    fs.writeFileSync(path.join(dir, 'app.js'), appJs);
    fs.writeFileSync(path.join(dir, 'routing.test.cjs'), 'require("node:test");');
    fs.mkdirSync(path.join(dir, 'media'));
    fs.writeFileSync(path.join(dir, 'media', 'film.mp4'), Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251)));
    const store = await Store.create(':memory:');
    const gateway = await Gateway.create({
      store,
      bus: new KarmaxBus(),
      tokens: new TokenAuthority(),
      contributions: new ContributionRegistry(),
      overlays: new Overlays(),
      client: {} as any,
      api: {} as any,
      taskQueue: 'test',
      staticDir: dir,
      agentInfo: { provider: 'mock', reason: 'static serving test' },
      worlds: new WorldRegistry(),
      githubApp: {} as any,
      identity: { session: async () => null, connectOrganizationNames: () => {} } as any,
    } as any);
    const running = await gateway.listen(await findFreePortFrom(48_600));
    base = running.url;
    close = running.close;
  }, 30_000);

  afterAll(async () => {
    await close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('answers a revalidation with 304 instead of resending the bundle', async () => {
    const first = await raw('/app.js');
    expect(first.status).toBe(200);
    expect(first.body.toString()).toBe(appJs);
    const etag = first.headers.etag;
    expect(etag).toMatch(/^"[^"]+"$/);
    // Still revalidated on every load, so a deploy is picked up at once.
    expect(first.headers['cache-control']).toBe('no-cache');

    const again = await raw('/app.js', { 'if-none-match': etag! });
    expect(again.status).toBe(304);
    expect(again.body.length).toBe(0);
    expect(again.headers.etag).toBe(etag);

    const stale = await raw('/app.js', { 'if-none-match': '"not-the-current-revision"' });
    expect(stale.status).toBe(200);
    expect(stale.body.toString()).toBe(appJs);
  });

  it('changes the validator when a deploy replaces the file', async () => {
    const before = (await raw('/app.js')).headers.etag;
    const next = appJs + 'export const deployed = true;\n';
    fs.writeFileSync(path.join(dir, 'app.js'), next);
    try {
      const after = await raw('/app.js', { 'if-none-match': before! });
      expect(after.status).toBe(200);
      expect(after.headers.etag).not.toBe(before);
      expect(after.body.toString()).toBe(next);
    } finally {
      fs.writeFileSync(path.join(dir, 'app.js'), appJs);
    }
  });

  it('compresses text assets for browsers that accept it', async () => {
    const br = await raw('/app.js', { 'accept-encoding': 'gzip, deflate, br' });
    expect(br.status).toBe(200);
    expect(br.headers['content-encoding']).toBe('br');
    expect(br.headers.vary).toMatch(/accept-encoding/i);
    expect(br.body.length).toBeLessThan(appJs.length / 10);
    expect(zlib.brotliDecompressSync(br.body).toString()).toBe(appJs);

    const gzip = await raw('/app.js', { 'accept-encoding': 'gzip' });
    expect(gzip.headers['content-encoding']).toBe('gzip');
    expect(zlib.gunzipSync(gzip.body).toString()).toBe(appJs);
    // Each representation has its own validator (RFC 9110 §8.8.3).
    expect(gzip.headers.etag).not.toBe(br.headers.etag);
    const revalidated = await raw('/app.js', { 'accept-encoding': 'gzip', 'if-none-match': gzip.headers.etag! });
    expect(revalidated.status).toBe(304);

    const identity = await raw('/app.js');
    expect(identity.headers['content-encoding']).toBeUndefined();
    expect(identity.body.toString()).toBe(appJs);
  });

  it('does not let another site frame the console', async () => {
    const shell = await raw('/', { 'accept-encoding': 'gzip' });
    expect(shell.status).toBe(200);
    expect(shell.headers['content-security-policy']).toBe(consoleContentSecurityPolicy(new URL(base).host));
    expect(shell.headers['content-security-policy']).toContain(`connect-src 'self' wss://${new URL(base).host} ws://${new URL(base).host}`);
    expect(shell.headers['content-security-policy']).toMatch(/frame-ancestors 'self'/);
    expect(shell.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(shell.headers['x-content-type-options']).toBe('nosniff');
    // Deep links get the same shell and the same protection.
    const deepLink = await raw('/personal/my-project/tasks/1');
    expect(deepLink.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(deepLink.body.toString()).toContain('<title>');
  });

  it('answers HEAD without a body', async () => {
    const head = await raw('/app.js', {}, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.body.length).toBe(0);
    expect(head.headers.etag).toMatch(/^"/);
  });

  // Safari plays a <video> only from a server that answers byte ranges (it
  // asks for bytes=0-1 first), and every browser seeks with them.
  it('answers byte ranges of a video, so every browser can play and seek it', async () => {
    const film = fs.readFileSync(path.join(dir, 'media', 'film.mp4'));
    const whole = await raw('/media/film.mp4');
    expect(whole.status).toBe(200);
    expect(whole.headers['accept-ranges']).toBe('bytes');
    expect(whole.headers['content-type']).toBe('video/mp4');
    expect(whole.headers['content-encoding']).toBeUndefined();
    expect(whole.body.equals(film)).toBe(true);

    const probe = await raw('/media/film.mp4', { range: 'bytes=0-1' });
    expect(probe.status).toBe(206);
    expect(probe.headers['content-range']).toBe('bytes 0-1/5000');
    expect(probe.headers['content-length']).toBe('2');
    expect(probe.body.equals(film.subarray(0, 2))).toBe(true);

    const tail = await raw('/media/film.mp4', { range: 'bytes=4000-' });
    expect(tail.status).toBe(206);
    expect(tail.headers['content-range']).toBe('bytes 4000-4999/5000');
    expect(tail.body.equals(film.subarray(4000))).toBe(true);
    const suffix = await raw('/media/film.mp4', { range: 'bytes=-10' });
    expect(suffix.headers['content-range']).toBe('bytes 4990-4999/5000');
    expect(suffix.body.equals(film.subarray(4990))).toBe(true);

    const beyond = await raw('/media/film.mp4', { range: 'bytes=6000-7000' });
    expect(beyond.status).toBe(416);
    expect(beyond.headers['content-range']).toBe('bytes */5000');
    // A range of a file that changed since (If-Range) is the whole new file.
    const changed = await raw('/media/film.mp4', { range: 'bytes=0-1', 'if-range': '"an-older-revision"' });
    expect(changed.status).toBe(200);
    expect(changed.body.length).toBe(5000);
    const same = await raw('/media/film.mp4', { range: 'bytes=0-1', 'if-range': whole.headers.etag! });
    expect(same.status).toBe(206);
    // Text the gateway compresses is never sliced: a range there is the whole response.
    const script = await raw('/app.js', { range: 'bytes=0-1', 'accept-encoding': 'gzip' });
    expect(script.status).toBe(200);
  });

  it('does not publish the console test suites', async () => {
    expect((await raw('/routing.test.cjs')).status).toBe(404);
  });

  it('negotiates encodings by quality', () => {
    expect(preferredEncoding(undefined)).toBeUndefined();
    expect(preferredEncoding('')).toBeUndefined();
    expect(preferredEncoding('gzip, deflate, br')).toBe('br');
    expect(preferredEncoding('gzip, br;q=0')).toBe('gzip');
    expect(preferredEncoding('br;q=0, gzip;q=0')).toBeUndefined();
    expect(preferredEncoding('*')).toBe('br');
    expect(preferredEncoding('*, br;q=0')).toBe('gzip');
    expect(preferredEncoding('identity')).toBeUndefined();
    expect(preferredEncoding('GZIP')).toBe('gzip');
  });

  it('serves its own HTML pages under a locked-down policy', async () => {
    const page = await raw('/api/github/oauth/callback');
    expect(page.status).toBe(400);
    expect(String(page.headers['content-type'])).toMatch(/^text\/html/);
    expect(page.headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  });
});
