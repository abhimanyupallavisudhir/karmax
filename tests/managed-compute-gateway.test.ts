import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { Vault } from '../src/autonomy/vault.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Gateway, routeCapability } from '../src/gateway/server.js';
import { ORGANIZATION_GRANT_CEILING } from '../src/platform/authorization.js';
import { PLATFORM_API_CATALOG } from '../src/platform/catalog.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { Store } from '../src/store/db.js';
import { Overlays } from '../src/store/overlays.js';
import { findFreePortFrom } from '../src/util/ports.js';
import { WorldRegistry } from '../src/world/registry.js';
import { MANAGED_COMPUTE, WorldProviderConnectionService } from '../src/world/connections.js';

/**
 * Managed compute accounts are the installation's: settings:read to see them,
 * settings:write to change them, and no organization grant reaches them — not
 * through the settings routes, nor through an organization path naming them.
 * Organizations see what it means for them: compute against their credit.
 */
describe('managed compute API', () => {
  let home: string;
  let store: Store;
  let base: string;
  let close: () => Promise<void>;
  let organizationId: string;
  const tokens = new TokenAuthority();
  const tokenFor: Record<string, string> = {};
  const call = (token: string, method: string, route: string, body?: unknown) => fetch(`${base}${route}`, { method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-managed-compute-api-'));
    fs.copyFileSync(new URL('../web/index.html', import.meta.url), path.join(home, 'index.html'));
    store = await Store.create(':memory:', { hosted: true });
    const broker = new CredentialBroker(new Vault(path.join(home, 'vault')));
    const providerConnections = new WorldProviderConnectionService(store, broker, { check: async () => {}, limits: async () => ({ cpu: 8 }) });
    const gateway = await Gateway.create({
      store, bus: new KarmaxBus(), tokens, contributions: new ContributionRegistry(), overlays: new Overlays(), hosted: true,
      client: { workflow: { getHandle: () => ({ query: async () => { throw new Error('no queue'); } }) } } as any,
      api: {} as any, taskQueue: 'test', staticDir: home, broker, providerConnections,
      agentInfo: { provider: 'mock', reason: 'managed compute test' }, worlds: new WorldRegistry(),
    } as any);
    const running = await gateway.listen(await findFreePortFrom(48_540));
    base = running.url; close = running.close;
    const tenant = await store.createOrganization({ name: 'Tenant', ownerUserId: 'owner' });
    organizationId = tenant.id;
    await store.setOrganizationPlan(tenant.id, 'individual');
    tokenFor.operator = (await tokens.mintPrincipal('user:op', ['settings:read', 'settings:write'])).token;
    tokenFor.reader = (await tokens.mintPrincipal('user:reader', ['settings:read'])).token;
    tokenFor.god = (await tokens.mintPrincipal('user:god', ['*'])).token;
    tokenFor.tenantOwner = (await tokens.mintPrincipal('user:owner', ORGANIZATION_GRANT_CEILING, undefined, undefined, tenant.id)).token;
  }, 30_000);
  afterAll(async () => { await close?.(); fs.rmSync(home, { recursive: true, force: true }); });

  it('is installation authority and listed for agents', () => {
    expect(routeCapability('GET', '/api/settings/managed-compute')).toBe('settings:read');
    expect(routeCapability('PUT', '/api/settings/managed-compute/e2b')).toBe('settings:write');
    expect(routeCapability('POST', '/api/settings/managed-compute/e2b/test')).toBe('settings:write');
    expect(routeCapability('POST', `/api/organizations/${organizationId}/subscription/gift-compute`)).toBe('subscription:gift');
    expect(routeCapability('POST', `/api/organizations/${organizationId}/subscription/compute-packs`)).toBe('payment:write');
    for (const prefix of ['GET /api/settings/managed-compute ', 'PUT|DELETE /api/settings/managed-compute/:provider ', 'POST /api/settings/managed-compute/:provider/test '])
      expect(PLATFORM_API_CATALOG.installation.some((entry: string) => entry.startsWith(prefix))).toBe(true);
  });

  it('lets an operator connect, test and disable an account, never showing its key', async () => {
    expect((await call(tokenFor.tenantOwner!, 'PUT', '/api/settings/managed-compute/e2b', { apiKey: 'stolen' })).status).toBe(403);
    expect((await call(tokenFor.reader!, 'PUT', '/api/settings/managed-compute/e2b', { apiKey: 'nope' })).status).toBe(403);
    const saved = await call(tokenFor.operator!, 'PUT', '/api/settings/managed-compute/e2b', { apiKey: 'operator-secret', config: { limits: { pool: { machines: 20 } }, share: 40 } });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(await saved.json())).not.toContain('operator-secret');
    expect((await call(tokenFor.operator!, 'POST', '/api/settings/managed-compute/e2b/test')).status).toBe(200);
    const listed = await (await call(tokenFor.reader!, 'GET', '/api/settings/managed-compute')).json();
    expect(listed).toMatchObject({ multiplier: 2, providers: [{ provider: 'e2b', enabled: true, status: 'ready', running: 0, runningCpus: 0,
      config: { limits: { pool: { machines: 20 } }, share: 40 }, limits: { cpu: 8, pool: { machines: 20 } }, costMicros: 0, chargedMicros: 0 }] });
    expect(JSON.stringify(listed)).not.toContain('operator-secret');
    expect((await call(tokenFor.tenantOwner!, 'GET', '/api/settings/managed-compute')).status).toBe(403);
    // No organization path reaches the installation's accounts, whatever the caller's authority.
    for (const token of [tokenFor.operator!, tokenFor.god!]) {
      expect((await call(token, 'GET', `/api/organizations/${MANAGED_COMPUTE}/world-providers`)).status).toBeGreaterThanOrEqual(403);
      expect([403, 404]).toContain((await call(token, 'PUT', `/api/organizations/${MANAGED_COMPUTE}/world-providers/e2b`, { apiKey: 'x' })).status);
    }
    expect((await call(tokenFor.god!, 'PUT', `/api/organizations/${MANAGED_COMPUTE}/world-providers/e2b`, { apiKey: 'x' })).status).toBe(404);
  });

  it('shows an organization the provider and its compute against the credit, not the account', async () => {
    const providers = await (await call(tokenFor.tenantOwner!, 'GET', `/api/organizations/${organizationId}/world-providers`)).json();
    expect(providers).toEqual([expect.objectContaining({ provider: 'e2b', managed: true })]);
    expect(JSON.stringify(providers)).not.toMatch(/maxRunning|"pool"|"share"|operator-secret/);
    await store.recordUsage({ id: 'usage:e2b:x', organizationId, provider: 'e2b', kind: 'world.active', quantity: 3600, unit: 'second',
      costMicros: 1_000_000, startedAt: Date.now() - 3_700_000, endedAt: Date.now() - 100_000, fundingSource: 'managed' });
    const entitlements = await (await call(tokenFor.tenantOwner!, 'GET', `/api/organizations/${organizationId}/entitlements`)).json();
    expect(entitlements).toMatchObject({ computeCreditMicros: 5_000_000, compute: { usedMicros: 2_000_000, providers: ['e2b'] },
      currentMonthlyPriceCents: 900 });
    const launch = await (await fetch(`${base}/api/launch`)).json();
    expect(launch).toMatchObject({ managedCompute: ['e2b'], packs: { compute: { creditMicros: 10_000_000, monthlyPriceCents: 1_000 }, computePriceMultiplier: 2 } });

    expect((await call(tokenFor.operator!, 'PUT', '/api/settings/managed-compute/e2b', { enabled: false })).status).toBe(200);
    expect(await (await call(tokenFor.tenantOwner!, 'GET', `/api/organizations/${organizationId}/world-providers`)).json()).toEqual([]);
    expect(((await (await call(tokenFor.tenantOwner!, 'GET', `/api/organizations/${organizationId}/entitlements`)).json()) as { compute: unknown }).compute).toBeNull();
    expect((await call(tokenFor.operator!, 'DELETE', '/api/settings/managed-compute/e2b')).status).toBe(200);
  });
});
