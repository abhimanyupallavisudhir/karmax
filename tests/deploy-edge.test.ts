import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const deployDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'deploy');
const read = (name: string) => fs.readFileSync(path.join(deployDir, name), 'utf8');

/** The `path` patterns of every rate-limit zone declared in the Caddyfile. */
function zonePaths(caddyfile: string): string[] {
  return [...caddyfile.matchAll(/^\s*path\s+(.+)$/gm)].flatMap((m) => m[1].trim().split(/\s+/));
}

/** Caddy's path matcher: a trailing `*` is a prefix match, anything else exact. */
const covers = (pattern: string, route: string) =>
  pattern.endsWith('*') ? route.startsWith(pattern.slice(0, -1)) : pattern === route;

describe('public edge (Caddy) rate limiting', () => {
  // Open registration is reachable by anyone on the internet, and karmax's own
  // /api/signup and /api/login call Better Auth's server API directly — which
  // bypasses Better Auth's router-level limiter (it only runs in onRequest).
  // The edge is therefore the ONLY thing standing in front of these routes.
  // /api/invitations/accept is likewise unauthenticated and hands out
  // organization membership in exchange for a token.
  const unprotectedByBetterAuth = ['/api/signup', '/api/setup', '/api/login', '/api/invitations/accept'];

  it('rate-limits every account-creation and credential route the gateway exposes', () => {
    const patterns = zonePaths(read('Caddyfile'));
    for (const route of unprotectedByBetterAuth)
      expect(patterns.some((p) => covers(p, route)), `${route} is not covered by any rate_limit zone`).toBe(true);
  });

  it('rate-limits the Better Auth routes too, so a limiter regression there is not fatal', () => {
    expect(zonePaths(read('Caddyfile')).some((p) => covers(p, '/api/auth/sign-in/email'))).toBe(true);
  });

  it('applies a catch-all zone so an uncatalogued route is never unlimited', () => {
    // A zone with no `match` block applies to every request.
    const zones = read('Caddyfile').match(/zone\s+\w+\s*\{[\s\S]*?\n\t\t\}/g) ?? [];
    expect(zones.length).toBeGreaterThan(0);
    expect(zones.some((z) => !z.includes('match'))).toBe(true);
  });

  it('keys every zone on the client address rather than a spoofable header', () => {
    const caddyfile = read('Caddyfile');
    const keys = [...caddyfile.matchAll(/^\s*key\s+(.+)$/gm)].map((m) => m[1].trim());
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(key).toBe('{http.request.remote.host}');
  });

  it('leaves preview origins unmetered so a user app is not throttled by the control plane', () => {
    // The preview block is lease-gated and serves someone's running app; a
    // shared control-plane budget there would throttle legitimate traffic.
    const previewBlock = read('Caddyfile').split('handle @preview {')[1]?.split('\n\t\t}')[0] ?? '';
    expect(previewBlock).not.toContain('rate_limit');
  });
});

describe('public edge (Caddy) image', () => {
  // rate_limit is a third-party module: the stock caddy image does not have it
  // and refuses to start on an unrecognised directive. Building it is what
  // makes the Caddyfile above valid at all.
  it('builds Caddy with the rate-limit module', () => {
    const dockerfile = read('Caddy.Dockerfile');
    expect(dockerfile).toContain('xcaddy build');
    expect(dockerfile).toContain('github.com/mholt/caddy-ratelimit');
  });

  for (const compose of ['compose.turnkey.yml', 'compose.hosted.yml']) {
    it(`${compose} builds that image instead of pulling the stock one`, () => {
      const caddyService = read(compose).split('\n  caddy:')[1] ?? '';
      expect(caddyService, `${compose} has no caddy service`).not.toBe('');
      expect(caddyService).toContain('Caddy.Dockerfile');
      expect(caddyService).not.toMatch(/^\s+image:\s*caddy:/m);
    });
  }
});
