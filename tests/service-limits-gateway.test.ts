import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { Vault } from '../src/autonomy/vault.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Gateway, routeCapability } from '../src/gateway/server.js';
import { CLOUDFLARE_TOKEN_HANDLE, ServiceLimitsService } from '../src/ops/service-limits.js';
import { ORGANIZATION_GRANT_CEILING } from '../src/platform/authorization.js';
import { PLATFORM_API_CATALOG } from '../src/platform/catalog.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { Store } from '../src/store/db.js';
import { DeferredDeleteObjectStore } from '../src/store/deferred-delete.js';
import { LocalObjectStore } from '../src/store/objects.js';
import { ObjectReconciler } from '../src/store/object-reconciliation.js';
import { Overlays } from '../src/store/overlays.js';
import { findFreePortFrom } from '../src/util/ports.js';
import { WorldRegistry } from '../src/world/registry.js';

/**
 * Service limits describe the operator's own provider accounts, so they are
 * installation authority: `settings:read` to see them, `settings:write` to
 * change limits, credentials or run a check. No organization grant carries
 * either, however high. An agent holding the same capabilities gets the same
 * answers (human/agent parity), and the Cloudflare token is write-only.
 */
describe('service limits API authorization', () => {
  let home: string;
  let store: Store;
  let broker: CredentialBroker;
  let base: string;
  let close: () => Promise<void>;
  const tokens = new TokenAuthority();
  const as = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
  const call = (token: string, method: string, route = '/api/settings/service-limits', body?: unknown) =>
    fetch(`${base}${route}`, { method, headers: as(token), ...(body ? { body: JSON.stringify(body) } : {}) });
  const tokenFor: Record<string, string> = {};

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-service-limits-api-'));
    fs.copyFileSync(new URL('../web/index.html', import.meta.url), path.join(home, 'index.html'));
    store = await Store.create(':memory:');
    broker = new CredentialBroker(new Vault(path.join(home, 'vault')));
    const serviceLimits = new ServiceLimitsService({ store, broker, env: {}, dataDir: home,
      fetch: (async () => new Response('{}', { status: 503 })) as typeof fetch });
    const gateway = await Gateway.create({
      store, bus: new KarmaxBus(), tokens, contributions: new ContributionRegistry(), overlays: new Overlays(),
      client: {} as any, api: {} as any, taskQueue: 'test', staticDir: home, broker, serviceLimits,
      storageReconciler: new ObjectReconciler({ store, mode: 'delete',
        objects: new DeferredDeleteObjectStore(new LocalObjectStore(path.join(home, 'objects')), store, { delayMs: 0 }) }),
      agentInfo: { provider: 'mock', reason: 'service limits test' }, worlds: new WorldRegistry(),
    } as any);
    const running = await gateway.listen(await findFreePortFrom(48_500));
    base = running.url;
    close = running.close;
    const tenant = await store.createOrganization({ name: 'Tenant', ownerUserId: 'owner' });
    tokenFor.operator = (await tokens.mintPrincipal('user:op', ['settings:read', 'settings:write'])).token;
    tokenFor.reader = (await tokens.mintPrincipal('user:reader', ['settings:read'])).token;
    // An organization's Super-administrator holds everything an organization grant can carry.
    tokenFor.tenantOwner = (await tokens.mintPrincipal('user:owner', ORGANIZATION_GRANT_CEILING, undefined, undefined, tenant.id)).token;
    // A task agent acting with an operator's installation authority.
    tokenFor.agent = (await tokens.mint({ taskId: 'task_ops', profileId: 'agent', principal: 'agent:task_ops',
      ceiling: ['settings:read', 'settings:write'], grantorCaps: ['*'] })).token;
    tokenFor.projectAgent = (await tokens.mint({ taskId: 'task_dev', profileId: 'agent', principal: 'agent:task_dev',
      ceiling: ['project:read', 'task:*'], grantorCaps: ['*'] })).token;
  }, 30_000);

  afterAll(async () => {
    await close?.();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('is bound to installation settings capabilities and listed for agents', () => {
    expect(routeCapability('GET', '/api/settings/service-limits')).toBe('settings:read');
    expect(routeCapability('PUT', '/api/settings/service-limits')).toBe('settings:write');
    expect(routeCapability('POST', '/api/settings/service-limits/check')).toBe('settings:write');
    expect(PLATFORM_API_CATALOG.installation.some((entry: string) => entry.startsWith('GET|PUT /api/settings/service-limits '))).toBe(true);
    expect(PLATFORM_API_CATALOG.installation.some((entry: string) => entry.startsWith('POST /api/settings/service-limits/check '))).toBe(true);
  });

  it('reconciles the managed bucket for installation operators only, and a dry run deletes nothing', async () => {
    expect(routeCapability('GET', '/api/settings/storage-reconciliation')).toBe('settings:read');
    expect(routeCapability('POST', '/api/settings/storage-reconciliation')).toBe('settings:write');
    expect(PLATFORM_API_CATALOG.installation.some((entry: string) => entry.startsWith('GET|POST /api/settings/storage-reconciliation '))).toBe(true);
    const orphan = path.join(home, 'objects', 'checkpoints', 'org_x', 'p', 't', 'lost.bin');
    fs.mkdirSync(path.dirname(orphan), { recursive: true });
    fs.writeFileSync(orphan, 'lost');
    const old = new Date(Date.now() - 3 * 86_400_000);
    fs.utimesSync(orphan, old, old);
    for (const who of ['tenantOwner', 'projectAgent', 'reader'])
      expect((await call(tokenFor[who]!, 'POST', '/api/settings/storage-reconciliation', { dryRun: true })).status).toBe(403);
    expect(await (await call(tokenFor.reader!, 'GET', '/api/settings/storage-reconciliation')).json()).toEqual({ report: null });
    const dry = await call(tokenFor.agent!, 'POST', '/api/settings/storage-reconciliation', { dryRun: true });
    expect(dry.status).toBe(200);
    expect(((await dry.json()) as { report: unknown }).report).toMatchObject({ mode: 'report', orphans: { count: 1, bytes: 4 }, deleted: { count: 0 },
      sample: [{ key: 'checkpoints/org_x/p/t/lost.bin', bytes: 4 }] });
    expect(fs.existsSync(orphan)).toBe(true);
    const last = (await (await call(tokenFor.reader!, 'GET', '/api/settings/storage-reconciliation')).json()) as { report: { orphans: { count: number } } };
    expect(last.report.orphans.count).toBe(1);
  });

  it('shows the page to installation readers and operators only', async () => {
    for (const who of ['operator', 'reader', 'agent']) {
      const response = await call(tokenFor[who]!, 'GET');
      expect(response.status, who).toBe(200);
      const view = await response.json() as any;
      expect(view.services.map((service: any) => service.id)).toContain('composio');
      expect(view.canManage, who).toBe(who !== 'reader');
    }
    for (const who of ['tenantOwner', 'projectAgent']) expect((await call(tokenFor[who]!, 'GET')).status, who).toBe(403);
  });

  it('lets only operators change limits or run a check', async () => {
    const edit = { services: { composio: { plan: 'Pro', limits: { 'composio.tool-calls': 400_000 } } } };
    for (const who of ['reader', 'tenantOwner', 'projectAgent']) {
      expect((await call(tokenFor[who]!, 'PUT', undefined, edit)).status, who).toBe(403);
      expect((await call(tokenFor[who]!, 'POST', '/api/settings/service-limits/check')).status, who).toBe(403);
    }
    expect((await store.kvGet('service-limits:settings'))).toBeUndefined();

    const saved = await call(tokenFor.agent!, 'PUT', undefined, edit);
    expect(saved.status).toBe(200);
    const composio = (await saved.json() as any).services.find((service: any) => service.id === 'composio');
    expect(composio).toMatchObject({ plan: 'Pro', planSource: 'entered' });
    expect(composio.meters[0]).toMatchObject({ id: 'composio.tool-calls', limit: 400_000, limitSource: 'entered' });

    const checked = await call(tokenFor.operator!, 'POST', '/api/settings/service-limits/check');
    expect(checked.status).toBe(200);
    expect((await checked.json() as any).checkedAt).toEqual(expect.any(Number));
    expect((await call(tokenFor.operator!, 'PUT', undefined, { services: { composio: { limits: { 'composio.tool-calls': -5 } } } })).status).toBe(400);
  });

  it('stores the Cloudflare token in the vault and never returns it', async () => {
    const response = await call(tokenFor.operator!, 'PUT', undefined,
      { cloudflare: { accountId: '35e42bcea7b0b9f09dce2860d587d418', apiToken: 'cfut_secret_value' } });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain('cfut_secret_value');
    expect(JSON.parse(text).cloudflare).toEqual({ accountId: '35e42bcea7b0b9f09dce2860d587d418', tokenConfigured: true });
    expect(await broker.resolve(CLOUDFLARE_TOKEN_HANDLE, { caps: [`use-credential:${CLOUDFLARE_TOKEN_HANDLE}`] })).toBe('cfut_secret_value');
    // The stubbed provider is down: the row says so, without echoing the request.
    const workers = JSON.parse(text).services.find((service: any) => service.id === 'cloudflare-workers');
    expect(workers).toMatchObject({ status: 'failed', error: 'Cloudflare answered 503' });
    expect(await (await call(tokenFor.reader!, 'GET')).text()).not.toContain('cfut_secret_value');
  });
});
