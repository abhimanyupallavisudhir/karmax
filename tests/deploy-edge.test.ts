import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const deployDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'deploy');
const read = (name: string) => fs.readFileSync(path.join(deployDir, name), 'utf8');

it('bounds container memory and log growth in both deployment profiles', () => {
  for (const file of ['compose.turnkey.yml', 'compose.hosted.yml']) {
    const compose = parse(read(file)) as { services: Record<string, { mem_limit?: string; logging?: { options?: Record<string, string> } }> };
    for (const [name, service] of Object.entries(compose.services)) {
      expect(service.mem_limit, `${file}: ${name}`).toBeDefined();
      expect(service.logging?.options?.['max-size'], `${file}: ${name}`).toBeDefined();
      expect(service.logging?.options?.['max-file'], `${file}: ${name}`).toBeDefined();
    }
  }
});

/**
 * Run `deploy/karmax`'s `configure()` against a throwaway deployment directory.
 *
 * Sourcing the script with no arguments makes its dispatcher print usage and
 * return, which leaves the functions defined; the path variables it derived from
 * its own location are then repointed at the temp dir. No Docker involved.
 */
function runConfigure(seed: string | undefined, domain = 'krmax.example.com'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-deploy-'));
  try {
    if (seed !== undefined) fs.writeFileSync(path.join(dir, '.turnkey.env'), seed);
    execFileSync('sh', ['-c',
      `. "${path.join(deployDir, 'karmax')}" >/dev/null 2>&1 || true\n`
      + `DEPLOY_DIR="${dir}"; ENV_FILE="${dir}/.turnkey.env"; SECRETS_DIR="${dir}/.secrets"\n`
      + `configure "${domain}"`,
    ], { encoding: 'utf8' });
    return fs.readFileSync(path.join(dir, '.turnkey.env'), 'utf8');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

it('removes temporary deployment configuration fixtures', () => {
  const fixtureDirs = () => fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('karmax-deploy-')).sort();
  const before = fixtureDirs();
  runConfigure(undefined);
  expect(fixtureDirs()).toEqual(before);
});

/** The `path` patterns of every rate-limit zone declared in the Caddyfile. */
function zonePaths(caddyfile: string): string[] {
  return [...caddyfile.matchAll(/^\s*path\s+(.+)$/gm)].flatMap((m) => m[1]!.trim().split(/\s+/));
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
    const keys = [...caddyfile.matchAll(/^\s*key\s+(.+)$/gm)].map((m) => m[1]!.trim());
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

describe('public edge (Caddy) canonical host', () => {
  const caddyfile = read('Caddyfile');
  const wwwBlock = caddyfile.split('www.{$KARMAX_DOMAIN} {')[1]?.split('\n}')[0] ?? '';

  // Without a site block of its own, the www host has no certificate, so a
  // visitor who types it gets a TLS error rather than the console.
  it('answers on the www host', () => {
    expect(wwwBlock, 'no www site block').not.toBe('');
  });

  it('redirects to the apex rather than serving a second origin', () => {
    // Two origins serving the same app would split sessions and quietly widen
    // what the preview-origin separation is supposed to keep apart.
    expect(wwwBlock).toContain('redir https://{$KARMAX_DOMAIN}{uri}');
    expect(wwwBlock).not.toContain('reverse_proxy');
  });

  it('preserves the path and query so a deep link still lands', () => {
    expect(wwwBlock).toMatch(/redir\s+\S*\{uri\}/);
  });

  it('meters the redirect too, so it is not a free unbounded endpoint', () => {
    expect(wwwBlock).toContain('import karmax_ratelimit');
  });
});

describe('public edge (Caddy) image', () => {
  it('keeps signed legacy webhooks reachable without redirecting their POSTs', () => {
    const legacy = read('Caddyfile').split('{$KARMAX_LEGACY_DOMAIN:http://127.0.0.1:65535} {')[1]?.split('\n}')[0] ?? '';
    expect(legacy).toContain('import karmax_ratelimit');
    expect(legacy).toContain('handle /api/github/webhook {\n\t\treverse_proxy app:4505');
    expect(legacy).toContain('handle {\n\t\tredir https://{$KARMAX_DOMAIN}{uri} permanent');
  });

  // rate_limit is a third-party module: the stock caddy image does not have it
  // and refuses to start on an unrecognised directive. Building it is what
  // makes the Caddyfile above valid at all.
  it('builds Caddy with the rate-limit module', () => {
    const dockerfile = read('Caddy.Dockerfile');
    expect(dockerfile).toContain('COPY build-caddy.sh /usr/local/bin/build-caddy.sh');
    expect(dockerfile).toContain('RUN sh /usr/local/bin/build-caddy.sh');
    expect(read('build-caddy.sh')).toContain('xcaddy build');
    expect(read('build-caddy.sh')).toContain('github.com/mholt/caddy-ratelimit@v0.1.0');
  });

  for (const compose of ['compose.turnkey.yml', 'compose.hosted.yml']) {
    it(`${compose} never passes empty legacy site addresses to Caddy`, () => {
      // Caddy's own default only handles UNSET variables, not empty ones.
      expect(read(compose)).toContain('KARMAX_LEGACY_DOMAIN: ${KARMAX_LEGACY_DOMAIN:-http://127.0.0.1:65535}');
      expect(read(compose)).toContain('KARMAX_LEGACY_WWW_DOMAIN: ${KARMAX_LEGACY_WWW_DOMAIN:-http://127.0.0.1:65534}');
    });

    it(`${compose} builds that image instead of pulling the stock one`, () => {
      const caddyService = read(compose).split('\n  caddy:')[1] ?? '';
      expect(caddyService, `${compose} has no caddy service`).not.toBe('');
      expect(caddyService).toContain('Caddy.Dockerfile');
      expect(caddyService).not.toMatch(/^\s+image:\s*caddy:/m);
    });
  }
});

// A compose `environment:` block is a whitelist: a variable an operator sets in
// .turnkey.env reaches the app ONLY if it is named here. Anything absent fails
// silently and looks exactly like a bug in the feature — the operator sets a
// social OAuth client, restarts, and the sign-in button never appears.
describe('compose forwards optional identity providers', () => {
  const appService = (compose: string) => read(compose).split('\n  app:')[1]?.split('\n  caddy:')[0] ?? '';

  for (const compose of ['compose.turnkey.yml', 'compose.hosted.yml']) {
    for (const name of ['KARMAX_GOOGLE_CLIENT_ID', 'KARMAX_GOOGLE_CLIENT_SECRET',
      'KARMAX_GITHUB_OAUTH_CLIENT_ID', 'KARMAX_GITHUB_OAUTH_CLIENT_SECRET',
      'KARMAX_OIDC_ISSUER', 'KARMAX_OIDC_DISCOVERY_URL', 'KARMAX_OIDC_CLIENT_ID', 'KARMAX_OIDC_CLIENT_SECRET']) {
      it(`${compose} passes ${name} through from the env file`, () => {
        expect(appService(compose)).toMatch(new RegExp(`^\\s+${name}:`, 'm'));
      });
    }

    // Empty default, not `:?` — these are optional. An install with no social
    // client must still boot, with the corresponding buttons simply absent.
    it(`${compose} keeps them optional so an install without them still boots`, () => {
      for (const line of appService(compose).split('\n').filter((l) => /KARMAX_(GOOGLE|GITHUB_OAUTH|OIDC)_/.test(l))) {
        expect(line, line).not.toContain(':?');
      }
    });
  }
});

it('forwards optional Stripe Issuing settings in both deployment profiles', () => {
  for (const file of ['compose.turnkey.yml', 'compose.hosted.yml']) {
    const app = read(file).split('\n  app:')[1]?.split('\n  caddy:')[0] ?? '';
    for (const name of ['STRIPE_CLIENT_ID', 'STRIPE_WEBHOOK_SECRET'])
      expect(app, `${file}: ${name}`).toMatch(new RegExp(`^\\s+${name}:`, 'm'));
  }
});

describe('compose provisions the PostgreSQL application database', () => {
  it('turnkey creates and connects the separate karmax database', () => {
    expect(read('temporal/setup-postgres.sh')).toContain('--db karmax create');
    expect(read('compose.turnkey.yml')).toContain('KARMAX_DATABASE_URL_FILE: /run/secrets/database_url');
  });

  it('managed hosting mounts the database URL as a secret', () => {
    const compose = read('compose.hosted.yml');
    expect(compose).toContain('KARMAX_DATABASE_URL_FILE: /run/secrets/database_url');
    expect(compose).toContain('database_url: { file: ./.secrets/database_url }');
  });
});

// `./deploy/karmax up` is documented as "Configure or start", so operators re-run
// it — and it regenerates .turnkey.env from scratch. Anything it does not know to
// carry over is deleted, which is how a working social sign-in disappears at the
// next deploy with no error anywhere: the var is gone, so the button is gone.
describe('deploy/karmax preserves operator settings across a re-run', () => {
  it('keeps variables it does not manage itself', () => {
    const seeded = [
      'KARMAX_DOMAIN=krmax.example.com',
      'KARMAX_PREVIEW_DOMAIN=preview.krmax.example.com',
      'KARMAX_CLOUD_WORLD_PROVIDER=daytona',
      'POSTGRES_PASSWORD=keep-me',
      'KARMAX_GOOGLE_CLIENT_ID=123.apps.googleusercontent.com',
      'KARMAX_GOOGLE_CLIENT_SECRET=GOCSPX-shh',
      'KARMAX_GITHUB_OAUTH_CLIENT_ID=github-client',
      'KARMAX_GITHUB_OAUTH_CLIENT_SECRET=github-secret',
      '',
    ].join('\n');
    const result = runConfigure(seeded);
    expect(result).toContain('KARMAX_GOOGLE_CLIENT_ID=123.apps.googleusercontent.com');
    expect(result).toContain('KARMAX_GOOGLE_CLIENT_SECRET=GOCSPX-shh');
    expect(result).toContain('KARMAX_GITHUB_OAUTH_CLIENT_ID=github-client');
    expect(result).toContain('KARMAX_GITHUB_OAUTH_CLIENT_SECRET=github-secret');
    // Without regressing what it already carried over.
    expect(result).toContain('POSTGRES_PASSWORD=keep-me');
    expect(result).toContain('KARMAX_CLOUD_WORLD_PROVIDER=daytona');
    // And exactly once each — a re-run must not append duplicates.
    expect(result.match(/^KARMAX_GOOGLE_CLIENT_ID=/gm)).toHaveLength(1);
    expect(result.match(/^KARMAX_DOMAIN=/gm)).toHaveLength(1);
  });

  it('consumes a staged domain migration while preserving the former origin', () => {
    const seeded = [
      'KARMAX_DOMAIN=krmax.example.com',
      'KARMAX_PREVIEW_DOMAIN=preview.krmax.example.com',
      'KARMAX_PENDING_DOMAIN=tavya.example.com',
      'KARMAX_PENDING_PREVIEW_DOMAIN=preview.tavya.example.com',
      'POSTGRES_PASSWORD=keep-me',
      '',
    ].join('\n');
    const result = runConfigure(seeded, 'tavya.example.com');
    expect(result).toContain('KARMAX_DOMAIN=tavya.example.com');
    expect(result).toContain('KARMAX_PREVIEW_DOMAIN=preview.tavya.example.com');
    expect(result).toContain('KARMAX_LEGACY_DOMAIN=krmax.example.com');
    expect(result).toContain('KARMAX_LEGACY_WWW_DOMAIN=www.krmax.example.com');
    expect(result).not.toContain('KARMAX_PENDING_DOMAIN');
    expect(result).not.toContain('KARMAX_PENDING_PREVIEW_DOMAIN');
  });

  it('still writes a complete file for a first install', () => {
    const result = runConfigure(undefined);
    expect(result).toContain('KARMAX_DOMAIN=krmax.example.com');
    expect(result).toContain('KARMAX_PREVIEW_DOMAIN=preview.krmax.example.com');
    expect(result).toMatch(/^POSTGRES_PASSWORD=.+$/m);
  });
});
