import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
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

  it('leaves resource repositories to a budget per grant, which no peer address or header can imitate', () => {
    // Every remote world reaches them through the Cloudflare edge, so they all
    // share a few Cloudflare addresses: the app meters each verified grant.
    const site = read('Caddyfile').split('{$KARMAX_DOMAIN} {')[1]?.split('\n}')[0] ?? '';
    const repositories = site.split('handle /resource-repositories/* {')[1]?.split('\n\t}')[0] ?? '';
    expect(repositories).toContain('reverse_proxy 127.0.0.1:4505');
    expect(repositories).not.toContain('rate_limit');
    expect(repositories).not.toContain('import karmax_ratelimit');
    expect(read('Caddyfile')).not.toMatch(/key\s+\{http\.request\.header\./);
    // Everything else still goes through the per-address budgets.
    expect(site.split('handle {')[1] ?? '').toContain('import karmax_ratelimit');
  });

  it('leaves preview origins unmetered so a user app is not throttled by the control plane', () => {
    // The preview block is lease-gated and serves someone's running app; a
    // shared control-plane budget there would throttle legitimate traffic.
    const previewBlock = read('Caddyfile').split('handle @preview {')[1]?.split('\n\t\t}')[0] ?? '';
    expect(previewBlock).not.toContain('rate_limit');
  });
});

describe('public edge (Caddy) configuration changes', () => {
  // Caddy's admin API is off, and Compose recreates a container when its
  // configuration changes, not when a file it mounts does. Without this a
  // release's Caddyfile waited for a manual restart: tavya.io kept the console's
  // per-address budget on resource repositories for days after 2026-10-04.
  it('labels Caddy with the Caddyfile digest in both deployment profiles', () => {
    for (const file of ['compose.turnkey.yml', 'compose.hosted.yml']) {
      const caddy = (parse(read(file)) as { services: Record<string, { labels?: Record<string, string> }> }).services.caddy;
      expect(caddy?.labels?.['karmax.caddyfile-sha256'], file).toBe('${KARMAX_CADDYFILE_SHA256:-}');
    }
  });

  it('passes the current Caddyfile digest to every Compose call, so `up` recreates Caddy when it changes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-caddyfile-'));
    try {
      fs.mkdirSync(path.join(dir, 'bin'));
      fs.writeFileSync(path.join(dir, 'bin', 'docker'), '#!/bin/sh\nprintf %s "$KARMAX_CADDYFILE_SHA256"\n', { mode: 0o755 });
      const up = () => execFileSync('sh', ['-c',
        `. "${path.join(deployDir, 'karmax')}" >/dev/null 2>&1 || true\nDEPLOY_DIR="${dir}"\ndc up -d`,
      ], { encoding: 'utf8', env: { ...process.env, PATH: `${path.join(dir, 'bin')}:${process.env.PATH}` } });
      const digest = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
      fs.writeFileSync(path.join(dir, 'Caddyfile'), 'before\n');
      expect(up()).toBe(digest('before\n'));
      fs.writeFileSync(path.join(dir, 'Caddyfile'), 'after\n');
      expect(up()).toBe(digest('after\n'));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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
    expect(legacy).toContain('handle /api/github/webhook {\n\t\treverse_proxy 127.0.0.1:4505');
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
    expect(read('compose.turnkey.yml')).toContain('KARMAX_DATABASE_URL_FILE: /run/karmax-database/database_url');
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

it('gives app responses without a policy a locked-down default on the console origin only', () => {
  const caddyfile = read('Caddyfile');
  const site = (name: string) => caddyfile.slice(caddyfile.indexOf(`${name} {`), caddyfile.indexOf('\n}\n', caddyfile.indexOf(`${name} {`)));
  // `?` sets the header only when the upstream response has none, so the
  // console's, public pages' and agent content's own policies stay in force.
  expect(site('{$KARMAX_DOMAIN}')).toContain(`header ?Content-Security-Policy "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"`);
  const security = caddyfile.slice(caddyfile.indexOf('(karmax_security) {'), caddyfile.indexOf('\n}\n', caddyfile.indexOf('(karmax_security) {')));
  expect(security).not.toMatch(/Content-Security-Policy/i);
  expect(site('https://')).not.toMatch(/Content-Security-Policy/i);
});

it('preserves public IPv6 peers and exposes the app only on host loopback (CI-8)', () => {
  for (const name of ['compose.turnkey.yml', 'compose.hosted.yml']) {
    const config = parse(read(name));
    expect(config.services.caddy.network_mode).toBe('host');
    expect(config.services.caddy.ports).toBeUndefined();
    expect(config.services.app.ports).toEqual(['127.0.0.1:4505:4505']);
    // The app trusts forwarded addresses only from its own bridge gateway, which
    // is where host-network Caddy's connections to the loopback port arrive
    // from. Nothing pins the Compose network, so updating an install never has
    // to rebuild it.
    expect(config.services.app.environment.KARMAX_TRUSTED_PROXY_IP).toBe('gateway');
    expect(config.networks?.default?.ipam).toBeUndefined();
  }
  expect(read('Caddyfile')).not.toContain('app:4505');
  expect(read('Caddyfile').match(/header_up X-Forwarded-For \{http.request.remote.host\}/g)).toHaveLength(4);
});

it('keeps Caddy\'s admin API off now that Caddy shares the host network (CI-8)', () => {
  // On the host network Caddy's default admin endpoint (localhost:2019) would
  // let any process on the host replace the edge's configuration unauthenticated.
  // Nothing reloads Caddy through it.
  const caddyfile = read('Caddyfile');
  const global = caddyfile.slice(caddyfile.indexOf('{'), caddyfile.indexOf('\n}\n'));
  expect(global).toMatch(/^\tadmin off$/m);
});

it('forwards the resource repository edge in both deployment profiles', () => {
  for (const file of ['compose.turnkey.yml', 'compose.hosted.yml']) {
    const app = read(file).split('\n  app:')[1]?.split('\n  caddy:')[0] ?? '';
    expect(app, file).toMatch(/^\s+KARMAX_RESOURCE_EDGE_URL: \$\{KARMAX_RESOURCE_EDGE_URL:-\}$/m);
  }
});

describe('deploy-repository-edge', () => {
  /** Run the command with Docker stubbed: the one-off container prints `printed`. */
  function deployEdge(seed: string, printed: string, token = 'cf-token') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-deploy-'));
    try {
      fs.writeFileSync(path.join(dir, '.turnkey.env'), seed);
      const log = path.join(dir, 'calls');
      let status = 0; let output = '';
      try {
        output = execFileSync('sh', ['-c',
          `. "${path.join(deployDir, 'karmax')}" >/dev/null 2>&1 || true\n`
          + `DEPLOY_DIR="${dir}"; ENV_FILE="${dir}/.turnkey.env"\n`
          + `need_docker() { :; }; wait_ready() { echo ready >> "${log}"; }\n`
          + `dc() { echo "$* token=$CLOUDFLARE_API_TOKEN" >> "${log}"; case "$1" in run) printf 'bundling\\n%s\\n' '${printed}';; esac; }\n`
          + `cmd_deploy_repository_edge`,
        ], { encoding: 'utf8', env: { ...process.env, CLOUDFLARE_API_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) { status = (error as { status: number }).status; output = String((error as { stderr: string }).stderr); }
      return { status, output, env: fs.readFileSync(path.join(dir, '.turnkey.env'), 'utf8'),
        calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [] };
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  const url = 'https://tavya-resource-repositories.tavya.workers.dev';

  it('deploys from a one-off app container, records the URL and restarts the app with it', () => {
    const run = deployEdge('KARMAX_DOMAIN=tavya.io\nKARMAX_RESOURCE_EDGE_URL=https://old.example.workers.dev\n', url);
    expect(run.status).toBe(0);
    expect(run.env).toBe(`KARMAX_DOMAIN=tavya.io\nKARMAX_RESOURCE_EDGE_URL=${url}\n`);
    expect(run.calls).toEqual(['run --rm --no-deps -T -e CLOUDFLARE_API_TOKEN -e CLOUDFLARE_ACCOUNT_ID app npm run --silent deploy-repository-edge token=cf-token',
      'up -d --no-build app token=cf-token', 'ready']);
  });

  it('leaves the app running when the URL is unchanged', () => {
    const run = deployEdge(`KARMAX_RESOURCE_EDGE_URL=${url}\n`, url);
    expect(run.status).toBe(0);
    expect(run.calls).toHaveLength(1);
  });

  it('changes nothing without a token or on an unexpected answer', () => {
    expect(deployEdge('KARMAX_DOMAIN=tavya.io\n', url, '')).toMatchObject({ status: 1, env: 'KARMAX_DOMAIN=tavya.io\n', calls: [] });
    const odd = deployEdge('KARMAX_DOMAIN=tavya.io\n', 'deploy-repository-edge: CLOUDFLARE_API_TOKEN is not set');
    expect(odd).toMatchObject({ status: 1, env: 'KARMAX_DOMAIN=tavya.io\n' });
    expect(odd.output).toMatch(/unexpected edge URL/);
  });
});
