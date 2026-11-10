import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Gateway, routeCapability } from '../src/gateway/server.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { WorldRegistry } from '../src/world/registry.js';
import { findFreePortFrom } from '../src/util/ports.js';
import { FEATURE_FLAGS } from '../src/config/feature-flags.js';
import { enabledFeatures, featureEnabled, hasEarlyAccess, rolloutStages, setEarlyAccess, setRolloutStage } from '../src/platform/early-access.js';

const flags = {
  canvas: { title: 'Canvas', description: 'Draw tasks.', stage: 'early' as const },
  timeline: { title: 'Timeline', description: 'See tasks over time.', stage: 'off' as const },
  search: { title: 'Search', description: 'Find anything.', stage: 'on' as const },
};

describe('early access', () => {
  it('turns a flag on for everyone, for organizations that opted in, or for no one', async () => {
    const store = await Store.create(':memory:');
    try {
      const early = (await store.createOrganization({ name: 'Early' })).id;
      const other = (await store.createOrganization({ name: 'Other' })).id;
      await setEarlyAccess(store, early, true);
      expect(await enabledFeatures(store, early, flags)).toEqual(['canvas', 'search']);
      expect(await enabledFeatures(store, other, flags)).toEqual(['search']);
      expect(await enabledFeatures(store, undefined, flags)).toEqual(['search']);
      // The operator moves flags; back at its shipped stage a flag follows the code again.
      await setRolloutStage(store, 'timeline', 'early', flags);
      await setRolloutStage(store, 'canvas', 'on', flags);
      expect(await enabledFeatures(store, other, flags)).toEqual(['canvas', 'search']);
      expect(await featureEnabled(store, early, 'timeline', flags)).toBe(true);
      await setRolloutStage(store, 'canvas', 'early', flags);
      expect(await store.getSettings('global', 'feature-flags')).toEqual({ timeline: 'early' });
      expect(await rolloutStages(store, flags)).toEqual({ canvas: 'early', timeline: 'early', search: 'on' });
      await expect(setRolloutStage(store, 'missing', 'on', flags)).rejects.toThrow('no feature flag missing');
      // Opting out, and deleting the organization, leave nothing behind.
      await setEarlyAccess(store, early, false);
      expect(await hasEarlyAccess(store, early)).toBe(false);
      await setEarlyAccess(store, other, true);
      await store.deleteOrganization(other);
      expect(await store.kvEntries('early-access:organization:')).toEqual([]);
    } finally { await store.close(); }
  });

  it('catalogs both routes under the authority that owns them', () => {
    expect(routeCapability('GET', '/api/settings/feature-flags')).toBe('settings:read');
    expect(routeCapability('PUT', '/api/settings/feature-flags')).toBe('settings:write');
    expect(routeCapability('GET', '/api/organizations/org_1/early-access')).toBe('organization:read');
    expect(routeCapability('PUT', '/api/organizations/org_1/early-access')).toBe('organization:edit');
  });
});

describe('early access over HTTP', async () => {
  const store = await Store.create(':memory:');
  const project = await store.createProject('Early');
  const organizationId = project.organizationId!;
  const tokens = new TokenAuthority();
  const operator = (await tokens.mintPrincipal('system:test', ['*'])).token;
  const member = (await tokens.mintPrincipal('system:member', ['organization:read', 'task:*'], project.id)).token;
  let base = '';
  let close: () => Promise<void>;
  const json = async (response: Promise<Response>) => (await (await response).json()) as any;
  const request = (url: string, method = 'GET', token = operator, body?: unknown) => fetch(`${base}${url}`, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  beforeAll(async () => {
    Object.assign(FEATURE_FLAGS, { canvas: flags.canvas });
    const gateway = await Gateway.create({ store, tokens, bus: new KarmaxBus(), contributions: new ContributionRegistry(),
      overlays: new Overlays(), client: {} as any, taskQueue: 'test', staticDir: 'web', api: {} as any,
      worlds: new WorldRegistry(), agentInfo: { provider: 'mock', reason: 'test' }, password: 'test-password' } as any);
    const running = await gateway.listen(await findFreePortFrom(48_760));
    base = running.url; close = running.close;
  });
  afterAll(async () => { delete FEATURE_FLAGS.canvas; await close?.(); await store.close(); });

  it('lets the operator move a flag and an administrator opt the organization in', async () => {
    const listed = await (await request('/api/settings/feature-flags')).json();
    expect(listed).toMatchObject({ canManage: true, earlyAccessOrganizations: 0,
      flags: [{ name: 'canvas', title: 'Canvas', stage: 'early', shippedStage: 'early' }] });
    const access = `/api/organizations/${organizationId}/early-access`;
    expect(await (await request(access)).json()).toEqual({ enabled: false, features: [], canManage: true });
    expect(await (await request(access, 'PUT', operator, { enabled: true })).json()).toMatchObject({ enabled: true, features: ['canvas'] });
    expect((await json(request('/api/settings/feature-flags'))).earlyAccessOrganizations).toBe(1);
    // The console learns each organization's features with the organization list.
    const organizations = await (await request('/api/organizations')).json() as Array<{ id: string; features?: string[] }>;
    expect(organizations.find((organization) => organization.id === organizationId)?.features).toEqual(['canvas']);
    expect((await request('/api/settings/feature-flags', 'PUT', operator, { name: 'canvas', stage: 'off' })).status).toBe(200);
    expect((await json(request(access))).features).toEqual([]);
    // Members read; only administrators and operators change anything.
    expect(await (await request(access, 'GET', member)).json()).toMatchObject({ enabled: true, canManage: false });
    expect((await request(access, 'PUT', member, { enabled: false })).status).toBe(403);
    expect((await request('/api/settings/feature-flags', 'GET', member)).status).toBe(403);
    expect((await request('/api/settings/feature-flags', 'PUT', member, { name: 'canvas', stage: 'on' })).status).toBe(403);
    // Malformed requests change nothing.
    expect((await request('/api/settings/feature-flags', 'PUT', operator, { name: 'missing', stage: 'on' })).status).toBe(400);
    expect((await request('/api/settings/feature-flags', 'PUT', operator, { name: 'canvas', stage: 'beta' })).status).toBe(400);
    expect((await request(access, 'PUT', operator, { enabled: 'yes' })).status).toBe(400);
    expect((await request('/api/organizations/org_missing/early-access')).status).toBe(404);
  });
});
