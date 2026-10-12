import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Gateway } from '../src/gateway/server.js';
import { previewHostname, previewLeaseOrigin, previewLeaseUrl, previewOrigins } from '../src/gateway/previews.js';
import { validateDeployment } from '../src/config/deployment.js';
import { Store } from '../src/store/db.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { Vault } from '../src/autonomy/vault.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { WorldRegistry } from '../src/world/registry.js';
import { findFreePortFrom } from '../src/util/ports.js';

// Previews moved from p-<hash>.preview.tavya.io (a certificate per lease) to
// their own registered domain under one wildcard certificate. A lease keeps
// the hostname it was issued, so links handed out before the move keep
// working, on demand, until they expire.
const LEGACY = 'https://preview.tavya.test';
const CURRENT = 'https://tavyausercontent.test';

describe('preview origins across a move to a new preview domain', () => {
  const env = { KARMAX_PREVIEW_ORIGIN: CURRENT, KARMAX_LEGACY_PREVIEW_ORIGIN: LEGACY } as NodeJS.ProcessEnv;

  it('issues new leases an opaque host directly under the new domain', () => {
    expect(previewHostname('lease-a', env)).toMatch(/^p-[a-f0-9]{24}\.tavyausercontent\.test$/);
    expect(previewHostname('lease-a', env)).not.toBe(previewHostname('lease-b', env));
    expect(previewLeaseOrigin('lease-a', env)).toBe(`https://${previewHostname('lease-a', env)}`);
    expect(previewOrigins(env)).toEqual([CURRENT, LEGACY]);
    expect(previewOrigins({ KARMAX_PREVIEW_ORIGIN: CURRENT })).toEqual([CURRENT]);
    expect(previewOrigins({ KARMAX_LEGACY_PREVIEW_ORIGIN: LEGACY })).toEqual([]);
  });

  it('keeps an earlier lease on the hostname it was issued', () => {
    const issued = previewHostname('lease-old', { KARMAX_PREVIEW_ORIGIN: LEGACY })!;
    expect(issued).toMatch(/\.preview\.tavya\.test$/);
    expect(previewLeaseOrigin({ id: 'lease-old', hostname: issued }, env)).toBe(`https://${issued}`);
    expect(previewLeaseUrl({ id: 'lease-old', hostname: issued }, '/app', 'tok', env))
      .toMatch(/^https:\/\/p-[a-f0-9]{24}\.preview\.tavya\.test\/preview\/lease-old\/app\?token=tok$/);
  });

  it('refuses a legacy preview origin that is not https or is the console', () => {
    const base = { KARMAX_DEPLOYMENT: 'hosted', KARMAX_PUBLIC_URL: 'https://tavya.test', KARMAX_PREVIEW_ORIGIN: CURRENT } as NodeJS.ProcessEnv;
    const failures = (extra: NodeJS.ProcessEnv) => { try { validateDeployment({ ...base, ...extra }); return ''; } catch (error) { return String(error); } };
    expect(failures({ KARMAX_LEGACY_PREVIEW_ORIGIN: 'http://preview.tavya.test' })).toContain('KARMAX_LEGACY_PREVIEW_ORIGIN must be an https URL');
    expect(failures({ KARMAX_LEGACY_PREVIEW_ORIGIN: 'https://tavya.test' })).toContain('KARMAX_LEGACY_PREVIEW_ORIGIN must use a different origin');
    expect(failures({ KARMAX_LEGACY_PREVIEW_ORIGIN: LEGACY })).not.toContain('LEGACY_PREVIEW');
  });
});

describe('the gateway serves both preview domains', () => {
  let store: Store;
  let url = '';
  let close: (() => Promise<void>) | undefined;
  let legacyLease: { id: string; hostname?: string };
  let currentLease: { id: string; hostname?: string };
  const saved = { origin: process.env.KARMAX_PREVIEW_ORIGIN, legacy: process.env.KARMAX_LEGACY_PREVIEW_ORIGIN };

  /** One request with an explicit Host, as Caddy forwards it. */
  const get = (requestPath: string, host: string) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const target = new URL(url);
    http.get({ host: target.hostname, port: target.port, path: requestPath, headers: { host, accept: 'text/html' } }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
    }).on('error', reject);
  });

  beforeAll(async () => {
    store = await Store.create(':memory:');
    const project = await store.createProject('Previews');
    const task = await store.createTask({ projectId: project.id, title: 'Run app', workflow: 'just-do', workflowVersion: '1', params: { prompt: '' } });
    const lease = (id: string) => ({ id, organizationId: project.organizationId!, projectId: project.id, taskId: task.id, worldId: task.id,
      generation: 1, port: 3000, public: false, provider: 'e2b', createdBy: 'owner', createdAt: Date.now(), expiresAt: Date.now() + 60 * 60_000 });
    // Issued before the move…
    process.env.KARMAX_PREVIEW_ORIGIN = LEGACY;
    delete process.env.KARMAX_LEGACY_PREVIEW_ORIGIN;
    legacyLease = await store.createPreviewLease(lease('preview-before'));
    // …and after it.
    process.env.KARMAX_PREVIEW_ORIGIN = CURRENT;
    process.env.KARMAX_LEGACY_PREVIEW_ORIGIN = LEGACY;
    currentLease = await store.createPreviewLease(lease('preview-after'));
    await store.revokePreviewLease(legacyLease.id);
    await store.revokePreviewLease(currentLease.id);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-preview-domain-'));
    const gateway = await Gateway.create({ store, broker: new CredentialBroker(new Vault(path.join(home, 'vault'))), bus: new KarmaxBus(),
      tokens: new TokenAuthority(), contributions: new ContributionRegistry(), overlays: new Overlays(), client: {} as any, api: {} as any,
      taskQueue: 'test', staticDir: home, agentInfo: { provider: 'mock', reason: 'preview domain test' }, worlds: new WorldRegistry() } as any);
    const running = await gateway.listen(await findFreePortFrom(48_600));
    url = running.url;
    close = running.close;
  });

  afterAll(async () => {
    await close?.();
    for (const [name, value] of [['KARMAX_PREVIEW_ORIGIN', saved.origin], ['KARMAX_LEGACY_PREVIEW_ORIGIN', saved.legacy]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });

  it('stores each lease with the host of the domain it was issued under', () => {
    expect(legacyLease.hostname).toMatch(/^p-[a-f0-9]{24}\.preview\.tavya\.test$/);
    expect(currentLease.hostname).toMatch(/^p-[a-f0-9]{24}\.tavyausercontent\.test$/);
  });

  it('answers Caddy\'s TLS ask for issued hosts on both domains, and nothing else', async () => {
    const ask = async (domain: string) => (await get(`/api/tls/preview-allow?domain=${encodeURIComponent(domain)}`, '127.0.0.1')).status;
    expect(await ask(legacyLease.hostname!)).toBe(204);
    expect(await ask(currentLease.hostname!)).toBe(204);
    expect(await ask(legacyLease.hostname!.replace('.preview.tavya.test', '.tavyausercontent.test'))).toBe(403);
    expect(await ask('p-000000000000000000000000.tavyausercontent.test')).toBe(403);
    expect(await ask('tavyausercontent.test')).toBe(403);
    expect(await ask('mail.tavyausercontent.test')).toBe(403);
  });

  it('serves each lease on its own host only', async () => {
    // A stopped preview explains itself (rather than a bare 404) on its own host.
    for (const lease of [legacyLease, currentLease]) {
      const own = await get(`/preview/${lease.id}/`, lease.hostname!);
      expect(own.status).toBe(404);
      expect(own.body).toMatch(/stopped/i);
    }
    // The other domain's twin host is not this lease's origin.
    const twin = legacyLease.hostname!.replace('.preview.tavya.test', '.tavyausercontent.test');
    expect((await get(`/preview/${legacyLease.id}/`, twin)).body).toMatch(/stopped|not found/i);
  });

  it('exposes nothing but leases on either preview domain, its apex included', async () => {
    for (const host of [currentLease.hostname!, legacyLease.hostname!, 'tavyausercontent.test', 'mail.tavyausercontent.test']) {
      const response = await get('/api/session', host);
      expect(response.status, host).toBe(404);
      expect(response.headers['set-cookie'], host).toBeUndefined();
    }
  });

  it('sends a console link to the lease\'s own host, without a referrer', async () => {
    for (const lease of [legacyLease, currentLease]) {
      const response = await get(`/preview/${lease.id}/page?x=1`, new URL(url).host);
      expect(response.status).toBe(307);
      expect(response.headers.location).toBe(`https://${lease.hostname}/preview/${lease.id}/page?x=1`);
      expect(response.headers['referrer-policy']).toBe('no-referrer');
    }
  });
});
