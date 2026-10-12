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
    const previewBlock = read('Caddyfile').split('(karmax_preview) {')[1]?.split('\n}')[0] ?? '';
    expect(previewBlock).toContain('reverse_proxy 127.0.0.1:4505');
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

describe('previews on their own domain, under one wildcard certificate', () => {
  const caddyfile = read('Caddyfile');
  const block = (head: string) => caddyfile.split(`${head} {`)[1]?.split('\n}')[0] ?? '';

  it('serves every preview host through one isolated, unmetered handler that sends no referrer', () => {
    const preview = block('(karmax_preview)');
    expect(preview).toContain('import karmax_security');
    expect(preview).toMatch(/header Referrer-Policy no-referrer/);
    expect(caddyfile.match(/import karmax_preview$/gm)).toHaveLength(2);
  });

  it('chooses how preview hosts get certificates from KARMAX_PREVIEW_TLS, on demand unless told otherwise', () => {
    expect(block('*.{$KARMAX_PREVIEW_DOMAIN}')).toContain('import preview_certificate_{$KARMAX_PREVIEW_TLS:on-demand}');
    expect(block('(preview_certificate_on-demand)')).toMatch(/tls \{\s+on_demand\s+\}/);
    // The Caddyfile's own ask stays: on demand, Caddy asks before issuing.
    expect(caddyfile).toContain('ask http://127.0.0.1:4505/api/tls/preview-allow');
  });

  it('proves the wildcard by DNS with a token read from a secret file, never the environment or the image', () => {
    const cloudflare = block('(preview_certificate_cloudflare)');
    expect(cloudflare).toContain('dns cloudflare {file./run/secrets/cloudflare_dns_api_token}');
    expect(caddyfile).not.toMatch(/\{env\.|CLOUDFLARE_API_TOKEN/);
    expect(read('Caddy.Dockerfile')).not.toMatch(/cloudflare_dns_api_token|API_TOKEN/);
    expect(read('build-caddy.sh')).toContain('github.com/caddy-dns/cloudflare@v0.2.4');
  });

  it('keeps hosts of the previous preview domain on demand until their leases end, and refuses every other name', () => {
    const catchAll = block('https://');
    expect(catchAll).toMatch(/tls \{\s+on_demand\s+\}/);
    expect(catchAll).toContain('@legacy_preview host *.{$KARMAX_LEGACY_PREVIEW_DOMAIN:invalid}');
    expect(catchAll).toMatch(/handle \{\s+abort\s+\}/);
    // No site answers for the bare preview domain.
    expect(caddyfile).not.toMatch(/^\{\$KARMAX_PREVIEW_DOMAIN\}/m);
  });

  for (const file of ['compose.turnkey.yml', 'compose.hosted.yml']) {
    it(`${file} gives Caddy and the app the preview settings, and Caddy alone the DNS token`, () => {
      const compose = parse(read(file)) as { services: Record<string, any>; secrets: Record<string, { file: string }> };
      const { caddy, app } = compose.services;
      expect(caddy.environment).toMatchObject({ KARMAX_PREVIEW_TLS: '${KARMAX_PREVIEW_TLS:-on-demand}',
        KARMAX_LEGACY_PREVIEW_DOMAIN: '${KARMAX_LEGACY_PREVIEW_DOMAIN:-invalid}' });
      expect(caddy.secrets).toEqual(['cloudflare_dns_api_token']);
      expect(compose.secrets.cloudflare_dns_api_token).toEqual({ file: './.secrets/cloudflare_dns_api_token' });
      expect(app.secrets).not.toContain('cloudflare_dns_api_token');
      expect(app.environment).toMatchObject({
        KARMAX_LEGACY_PREVIEW_ORIGIN: '${KARMAX_LEGACY_PREVIEW_DOMAIN:+https://${KARMAX_LEGACY_PREVIEW_DOMAIN}}',
        KARMAX_PREVIEW_TLS: '${KARMAX_PREVIEW_TLS:-on-demand}',
        KARMAX_AGENT_MAIL_DOMAIN: '${KARMAX_AGENT_MAIL_DOMAIN:-}' });
    });
  }

  /** Source deploy/karmax against a throwaway directory and run `script`. */
  function operator(env: string, script: string, token?: string) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-deploy-'));
    try {
      fs.writeFileSync(path.join(dir, '.turnkey.env'), env);
      if (token !== undefined) { fs.mkdirSync(path.join(dir, '.secrets')); fs.writeFileSync(path.join(dir, '.secrets', 'cloudflare_dns_api_token'), token); }
      let status = 0; let stderr = '';
      try {
        execFileSync('sh', ['-c', `. "${path.join(deployDir, 'karmax')}" >/dev/null 2>&1 || true\n`
          + `DEPLOY_DIR="${dir}"; ENV_FILE="${dir}/.turnkey.env"; SECRETS_DIR="${dir}/.secrets"\n${script}`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) { status = (error as { status: number }).status; stderr = String((error as { stderr: string }).stderr); }
      return { status, stderr, env: fs.readFileSync(path.join(dir, '.turnkey.env'), 'utf8') };
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  it('refuses a wildcard without its DNS token, naming the token and the permissions it needs', () => {
    const wildcard = 'KARMAX_PREVIEW_DOMAIN=usercontent.example\nKARMAX_PREVIEW_TLS=cloudflare\n';
    const missing = operator(wildcard, 'preview_tls_ready', '');
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('KARMAX_PREVIEW_TLS=cloudflare needs a Cloudflare API token with Zone DNS Edit and Zone Read on usercontent.example only, in deploy/.secrets/cloudflare_dns_api_token');
    expect(operator(wildcard, 'preview_tls_ready', 'cf-dns-token\n').status).toBe(0);
    expect(operator('KARMAX_PREVIEW_DOMAIN=preview.example\n', 'preview_tls_ready').status).toBe(0);
    expect(operator('KARMAX_PREVIEW_TLS=on-demand\n', 'preview_tls_ready').status).toBe(0);
    const typo = operator('KARMAX_PREVIEW_TLS=wildcard\n', 'preview_tls_ready');
    expect(typo).toMatchObject({ status: 1 });
    expect(typo.stderr).toContain('KARMAX_PREVIEW_TLS must be on-demand or cloudflare, not wildcard');
    // `up` stops before starting anything.
    const up = operator(`KARMAX_DOMAIN=tavya.example\n${wildcard}`, 'need_docker() { :; }; dc() { echo "dc $*" >&2; }; cmd_up', '');
    expect(up.status).toBe(1);
    expect(up.stderr).not.toContain('dc ');
    expect(up.stderr).toContain('previews are not configured; nothing was started');
  });

  it('checks the token in every update and in doctor', () => {
    const script = read('karmax');
    const update = script.slice(script.indexOf('cmd_update() {'), script.indexOf('\n}\n', script.indexOf('cmd_update() {')));
    expect(update.indexOf('preview_tls_ready')).toBeGreaterThan(update.indexOf('ensure_secrets'));
    expect(update.indexOf('preview_tls_ready')).toBeLessThan(update.indexOf('build_images --pull'));
    const doctor = script.slice(script.indexOf('cmd_doctor() {'), script.indexOf('\n}\n', script.indexOf('cmd_doctor() {')));
    expect(doctor).toContain('preview_tls_ready');
    // A changed Caddy image reaches the running edge only if updates build it.
    expect(script).toMatch(/dc build --pull app && dc build postgresql caddy/);
  });

  it('moving previews to a new domain keeps the previous one for the leases issued under it', () => {
    const seeded = 'KARMAX_DOMAIN=tavya.example\nKARMAX_PREVIEW_DOMAIN=preview.tavya.example\nPOSTGRES_PASSWORD=keep\n'
      + 'KARMAX_PENDING_PREVIEW_DOMAIN=usercontent.example\nKARMAX_PREVIEW_TLS=cloudflare\n';
    // What `update` does with a staged preview-only move.
    const moved = operator(seeded, 'configure "" "$(env_value KARMAX_PENDING_PREVIEW_DOMAIN)"').env;
    expect(moved).toContain('KARMAX_DOMAIN=tavya.example\n');
    expect(moved).toContain('KARMAX_PREVIEW_DOMAIN=usercontent.example\n');
    expect(moved).toContain('KARMAX_LEGACY_PREVIEW_DOMAIN=preview.tavya.example\n');
    expect(moved).toContain('KARMAX_PREVIEW_TLS=cloudflare\n');
    expect(moved).not.toContain('KARMAX_PENDING_PREVIEW_DOMAIN');
    expect(moved).not.toContain('KARMAX_LEGACY_DOMAIN=');
    // A later `up` keeps it; moving back drops it.
    expect(operator(moved, 'configure').env.match(/^KARMAX_LEGACY_PREVIEW_DOMAIN=preview\.tavya\.example$/gm)).toHaveLength(1);
    expect(operator(moved, 'configure tavya.example preview.tavya.example').env).toContain('KARMAX_LEGACY_PREVIEW_DOMAIN=usercontent.example\n');
    // An update consumes a preview-only move as it does a domain move.
    const script = read('karmax');
    expect(script).toContain('if [ -n "$pending_domain" ] || [ -n "$pending_preview" ]; then');
  });
});

describe('deploy-agent-mail-edge', () => {
  function deployMail(seed: string, args: string, printed: string, token = 'cf-token') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-deploy-'));
    try {
      fs.writeFileSync(path.join(dir, '.turnkey.env'), seed);
      const log = path.join(dir, 'calls');
      let status = 0; let output = '';
      try {
        output = execFileSync('sh', ['-c',
          `. "${path.join(deployDir, 'karmax')}" >/dev/null 2>&1 || true\n`
          + `DEPLOY_DIR="${dir}"; ENV_FILE="${dir}/.turnkey.env"; SECRETS_DIR="${dir}/.secrets"\n`
          + `need_docker() { :; }; wait_ready() { echo ready >> "${log}"; }\n`
          + `dc() { echo "$* token=$CLOUDFLARE_API_TOKEN" >> "${log}"; case "$1" in run) printf 'bundling\\n%s\\n' '${printed}';; esac; }\n`
          + `cmd_deploy_agent_mail_edge ${args}`,
        ], { encoding: 'utf8', env: { ...process.env, CLOUDFLARE_API_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) { status = (error as { status: number }).status; output = String((error as { stderr: string }).stderr); }
      return { status, output, env: fs.readFileSync(path.join(dir, '.turnkey.env'), 'utf8'),
        calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [] };
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  const seed = 'KARMAX_DOMAIN=tavya.io\nKARMAX_PREVIEW_DOMAIN=tavyausercontent.com\n';

  it('deploys from a one-off app container, records the mail domain and restarts the app with it', () => {
    const run = deployMail(seed, 'Mail.TavyaUserContent.com', 'tavya-agent-mail');
    expect(run.status).toBe(0);
    expect(run.env).toBe(`${seed}KARMAX_AGENT_MAIL_DOMAIN=mail.tavyausercontent.com\n`);
    expect(run.calls).toEqual([
      'run --rm --no-deps -T -e CLOUDFLARE_API_TOKEN -e CLOUDFLARE_ACCOUNT_ID -e KARMAX_AGENT_MAIL_DOMAIN=mail.tavyausercontent.com app npm run --silent deploy-agent-mail-edge token=cf-token',
      'up -d --no-build app token=cf-token', 'ready']);
    // Repeating it (a changed Worker) leaves the app running.
    expect(deployMail(run.env, 'mail.tavyausercontent.com', 'tavya-agent-mail').calls).toHaveLength(1);
  });

  it('keeps mail off the console and preview domains, and changes nothing without a token or on an odd answer', () => {
    for (const domain of ['tavya.io', 'tavyausercontent.com', 'not a domain', '']) {
      const run = deployMail(seed, domain ? `'${domain}'` : '', 'tavya-agent-mail');
      expect(run, domain).toMatchObject({ status: 1, env: seed, calls: [] });
    }
    expect(deployMail(seed, 'mail.tavyausercontent.com', 'tavya-agent-mail', '')).toMatchObject({ status: 1, env: seed, calls: [] });
    const odd = deployMail(seed, 'mail.tavyausercontent.com', 'deploy-agent-mail-edge: KARMAX_PUBLIC_URL is not set');
    expect(odd).toMatchObject({ status: 1, env: seed });
    expect(odd.output).toMatch(/unexpected answer/);
  });
});
