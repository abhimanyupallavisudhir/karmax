import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '../src/store/db.js';
import { storeBackends } from './helpers/store-backends.js';
import { AuthorizationService } from '../src/platform/authorization.js';
import { allows } from '../src/platform/capabilities.js';
import { Gateway } from '../src/gateway/server.js';
import { TokenAuthority } from '../src/platform/tokens.js';

describe.each(storeBackends)('authorization readers ($name)', ({ open }) => {
  let store: Store;
  afterEach(async () => { vi.restoreAllMocks(); (await store?.close()); });

  it('shares grant ceilings, scoped overlays, and group policy between sync and async readers', async () => {
    store = (await open());
    const auth = (await AuthorizationService.create(store));
    const org = (await store.createOrganization({ name: 'Policy' }));
    const otherOrg = (await store.createOrganization({ name: 'Other' }));
    const project = (await store.createProject('Project', {}, org.id));
    const other = (await store.createProject('Other project', {}, otherOrg.id));
    for (const user of ['member', 'team', 'all']) (await store.setOrganizationMembership(org.id, user, 'member'));
    const team = (await store.createTeam({ organizationId: org.id, name: 'Team' }));
    (await store.setTeamMembership(team.id, 'team'));
    (await store.setProjectMembership(project.id, { kind: 'team', teamId: team.id }, 'maintainer'));
    (await store.setProjectMembership(project.id, { kind: 'organization', organizationId: org.id }, 'viewer'));
    (await store.setProjectMembership(project.id, { kind: 'user', userId: 'member' }, 'custom'));
    (await store.setAuthorizationProfile(`project:${project.id}`, { id: 'custom', name: 'Custom', capabilities: ['task:edit'] }));
    (await store.setAuthorizationProfile('global', { id: 'shadowed', name: 'Global', capabilities: ['task:read'] }));
    (await store.setAuthorizationProfile(`project:${project.id}`, { id: 'shadowed', name: 'Project', capabilities: ['*'] }));
    for (const [user, scopeKey, profileId] of [
      ['root', 'global', 'god'], ['admin', `organization:${org.id}`, 'god'],
      ['maintainer', `project:${project.id}`, 'god'], ['shadow', 'global', 'shadowed'],
    ] as const) (await auth.grant('root', { principalId: `user:${user}`, scopeKey: scopeKey as any, profileId }));
    for (const principal of ['root', 'admin', 'maintainer', 'member', 'team', 'all', 'shadow', 'unknown']) {
      for (const projectId of [undefined, project.id, other.id])
        expect(await auth.capabilitiesAsync(`user:${principal}`, projectId)).toEqual((await auth.capabilities(`user:${principal}`, projectId)));
    }
    // One round trip per decision (2026-10 load test): sockets re-decide through a 4-connection pool.
    const reads = vi.spyOn(store.db, 'prepare');
    for (const principal of ['member', 'team', 'all', 'maintainer']) {
      reads.mockClear();
      await auth.capabilitiesAsync(`user:${principal}`, project.id);
      expect(reads).toHaveBeenCalledTimes(1);
    }
    reads.mockRestore();
    expect(allows(await auth.capabilitiesAsync('user:root', project.id), 'workflow:install')).toBe(true);
    expect(allows(await auth.capabilitiesAsync('user:admin', project.id), 'workflow:install')).toBe(false);
    expect(allows(await auth.capabilitiesAsync('user:maintainer', project.id), 'organization:delete')).toBe(false);
    expect(await auth.capabilitiesAsync('user:shadow', project.id)).toEqual(['task:read']);
    expect(await auth.capabilitiesAsync('user:team', other.id)).toEqual([]);
    expect((await auth.capabilities('', project.id))).toEqual([]);
    expect(await auth.capabilitiesAsync('', project.id)).toEqual([]);
    expect(allows(await auth.capabilitiesAsync('user:member', project.id), 'task:edit')).toBe(true);
    (await store.removeTeamMembership(team.id, 'team'));
    expect(allows(await auth.capabilitiesAsync('user:team', project.id), 'project:edit')).toBe(false);
    (await store.deleteAuthorizationProfile(`project:${project.id}`, 'custom'));
    expect(await auth.capabilitiesAsync('user:member', project.id)).toEqual((await auth.capabilities('user:member', project.id)));
    (await auth.revoke('root', 'user:admin', `organization:${org.id}`));
    expect(await auth.capabilitiesAsync('user:admin', project.id)).toEqual([]);
  });

  it('refreshes browser authority asynchronously and revokes the cached token after a grant is removed', async () => {
    store = (await open());
    const authorization = (await AuthorizationService.create(store));
    const org = (await store.createOrganization({ name: 'Browser' }));
    const project = (await store.createProject('App', {}, org.id));
    (await authorization.grant('root', { principalId: 'user:browser', scopeKey: `project:${project.id}`, profileId: 'maintainer' }));
    const tokens = new TokenAuthority();
    // Exercise the real auth boundary without starting unrelated gateway loops.
    const gateway = Object.create(Gateway.prototype) as any;
    gateway.deps = { store, tokens, authorization,
      paidLaunchSettings: { publicLaunchInfo: () => ({ paidLaunch: false }) },
      identity: { session: async () => ({ user: { id: 'browser', name: 'Browser', email: 'browser@example.test' }, session: { id: 'session' } }) } };
    tokens.connectIdentitySessions(async (id, userId) => id === 'session' && userId === 'browser');
    gateway.sessions = new Map();
    gateway.identityTokens = new Map();
    const sync = vi.spyOn(authorization, 'capabilities').mockImplementation(() => { throw Error('blocking permission read'); });
    const first = await gateway.auth({ headers: {} }, project.id);
    expect((await tokens.check(first.apiToken, 'project:edit', { projectId: project.id })).ok).toBe(true);
    expect((await gateway.auth({ headers: {} }, project.id)).apiToken).toBe(first.apiToken);
    (await authorization.revoke('root', 'user:browser', `project:${project.id}`));
    const after = await gateway.auth({ headers: {} }, project.id);
    expect((await tokens.verify(first.apiToken))).toBeUndefined();
    expect((await tokens.check(after.apiToken, 'project:edit', { projectId: project.id })).ok).toBe(false);
    expect(sync).not.toHaveBeenCalled();
  });


  it('preserves signup acceptance, linked SSO provider, and verified-domain requirements', async () => {
    store = (await open());
    const authorization = (await AuthorizationService.create(store));
    const org = (await store.createOrganization({ name: 'SSO' }));
    const project = (await store.createProject('SSO app', {}, org.id));
    (await store.setOrganizationMembership(org.id, 'browser', 'member'));
    (await store.setOrganizationIdentityPolicy({ organizationId: org.id, oidcProviderId: 'enterprise',
      enforceSso: true, verifiedDomains: ['example.test'] }));
    const gateway = Object.create(Gateway.prototype) as any;
    const tokens = new TokenAuthority();
    const user = { id: 'browser', name: 'Browser', email: 'browser@example.test' };
    const providers = vi.fn(async (): Promise<string[]> => []);
    gateway.deps = { store, tokens, authorization,
      paidLaunchSettings: { publicLaunchInfo: () => ({ paidLaunch: true }) },
      identity: { session: async () => ({ user, session: { id: 'session' } }), providersForUserAsync: providers } };
    tokens.connectIdentitySessions(async (id, userId) => id === 'session' && userId === 'browser');
    gateway.sessions = new Map(); gateway.identityTokens = new Map();
    vi.spyOn(store, 'policyAcceptances').mockImplementation(() => { throw Error('blocking policy scan'); });
    vi.spyOn(store, 'getOrganizationIdentityPolicy').mockImplementation(() => { throw Error('blocking SSO policy'); });
    expect(await gateway.auth({ headers: {} }, project.id)).toBeUndefined();
    (await store.recordPolicyAcceptance({ userId: user.id, context: 'checkout', versions: {} }));
    expect(await gateway.auth({ headers: {} }, project.id)).toBeUndefined();
    expect(providers).not.toHaveBeenCalled();
    (await store.recordPolicyAcceptance({ userId: user.id, context: 'signup', versions: {} }));
    expect(await gateway.auth({ headers: {} }, project.id)).toBeUndefined();
    providers.mockResolvedValue(['enterprise']);
    expect(await gateway.auth({ headers: {} }, project.id)).toMatchObject({ userId: user.id });
    user.email = 'browser@unverified.test';
    expect(await gateway.auth({ headers: {} }, project.id)).toBeUndefined();
  });
});
