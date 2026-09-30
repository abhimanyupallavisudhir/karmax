import { describe, it, expect, vi } from 'vitest';
import { Gateway } from '../src/gateway/server.js';
import { Store } from '../src/store/db.js';
import { AuthorizationService, projectScope } from '../src/platform/authorization.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxApi } from '../src/platform/api.js';

async function fixture() {
  const store = await Store.create(':memory:');
  const authorization = await AuthorizationService.create(store);
  const tokens = new TokenAuthority(store);
  const api = new KarmaxApi({ store, tokens, authorization, client: {} as any, taskQueue: 'test' });
  const mine = await store.createOrganization({ name: 'Mine', ownerUserId: 'alice' });
  const theirs = await store.createOrganization({ name: 'Theirs', ownerUserId: 'mallory' });
  await authorization.bootstrapOrganizationOwner('system:test', 'alice', mine.id);
  await authorization.bootstrapOrganizationOwner('system:test', 'mallory', theirs.id);
  const own = await store.createProject('Own', {}, mine.id);
  const shared = await store.createProject('Shared', {}, theirs.id);
  const foreign = await store.createProject('Foreign', {}, theirs.id);
  // A project grant in another organization reaches exactly that project.
  await store.setOrganizationMembership(theirs.id, 'alice', 'member');
  await authorization.grant('system:test', { principalId: 'user:alice', scopeKey: projectScope(shared.id), profileId: 'viewer' });
  for (const project of [own, shared, foreign])
    await store.createTask({ projectId: project.id, title: `hello from ${project.name}`, workflow: 'just-do',
      workflowVersion: '1', params: { prompt: 'fixture' } });
  const gateway = Object.create(Gateway.prototype) as any;
  gateway.deps = { store, tokens, authorization, api,
    identity: { providersForUserAsync: async () => [] } };
  return { store, authorization, tokens, api, gateway, mine, theirs, own, shared, foreign };
}

describe('cross-project console search (RQ-14/UI-18)', () => {
  it('searches only the projects the caller can read, without minting a token per project', async () => {
    const f = await fixture();
    try {
      const touched = new Set<string>();
      const capabilities = vi.spyOn(f.authorization, 'capabilitiesAsync');
      const check = vi.spyOn(f.tokens, 'check');
      const search = vi.spyOn(f.api, 'searchAuthorizedTasks');
      const mint = vi.spyOn(f.tokens, 'mint');
      const mintPrincipal = vi.spyOn(f.tokens, 'mintPrincipal');
      const session = { user: 'Alice', userId: 'alice', email: 'alice@example.com', apiToken: 'session' };
      const result = await f.gateway.searchProjects({ headers: {} }, { destroyed: false }, session, 'hello');
      expect(result.map((entry: any) => entry.projectId).sort()).toEqual([f.own.id, f.shared.id].sort());
      expect(result.find((entry: any) => entry.projectId === f.own.id).tasks[0].title).toBe('hello from Own');
      for (const call of capabilities.mock.calls) touched.add(String(call[1]));
      for (const call of check.mock.calls) touched.add(String(call[2]?.projectId));
      for (const call of search.mock.calls) touched.add(String(call[0]));
      expect(touched.has(f.foreign.id)).toBe(false);
      expect(mint).not.toHaveBeenCalled();
      expect(mintPrincipal).not.toHaveBeenCalled();
    } finally { await f.store.close(); }
  });

  it('keeps a scoped bearer inside its scope', async () => {
    const f = await fixture();
    try {
      const { token } = await f.tokens.mintPrincipal('user:mallory', ['project:read', 'task:read'], undefined, undefined, f.theirs.id);
      const check = vi.spyOn(f.tokens, 'check');
      const result = await f.gateway.searchProjects({ headers: {} }, { destroyed: false }, { user: 'agent', apiToken: token }, 'hello');
      expect(result.map((entry: any) => entry.projectId).sort()).toEqual([f.shared.id, f.foreign.id].sort());
      expect(check.mock.calls.some(call => call[2]?.projectId === f.own.id)).toBe(false);
      const { token: blind } = await f.tokens.mintPrincipal('user:mallory', ['project:read'], undefined, undefined, f.theirs.id);
      expect(await f.gateway.searchProjects({ headers: {} }, { destroyed: false }, { user: 'agent', apiToken: blind }, 'hello')).toEqual([]);
    } finally { await f.store.close(); }
  });

  it('honours an organization\'s SSO requirement for browser sessions', async () => {
    const f = await fixture();
    try {
      await f.store.setOrganizationIdentityPolicy({ organizationId: f.theirs.id, enforceSso: true, oidcProviderId: 'okta' });
      const session = { user: 'Alice', userId: 'alice', email: 'alice@example.com', apiToken: 'session' };
      const result = await f.gateway.searchProjects({ headers: {} }, { destroyed: false }, session, 'hello');
      expect(result.map((entry: any) => entry.projectId)).toEqual([f.own.id]);
    } finally { await f.store.close(); }
  });

  it('bounds each response and stops when the request is gone', async () => {
    const f = await fixture();
    try {
      for (let i = 0; i < 120; i++) await f.store.createTask({ projectId: f.own.id, title: `hello ${i}`, workflow: 'just-do',
        workflowVersion: '1', params: { prompt: 'fixture' } });
      const session = { user: 'Alice', userId: 'alice', email: 'alice@example.com', apiToken: 'session' };
      const [own] = (await f.gateway.searchProjects({ headers: {} }, { destroyed: false }, session, 'hello'))
        .filter((entry: any) => entry.projectId === f.own.id);
      expect(own.tasks).toHaveLength(100);
      expect(own.total).toBe(121);
      expect(await f.gateway.searchProjects({ headers: {} }, { destroyed: true }, session, 'hello')).toEqual([]);
      expect(await f.gateway.searchProjects({ headers: {} }, { destroyed: false }, session, 'h')).toEqual([]);
    } finally { await f.store.close(); }
  });

  it('does not disguise a search failure as an empty result', async () => {
    const f = await fixture();
    try {
      vi.spyOn(f.api, 'searchAuthorizedTasks').mockRejectedValue(new Error('database unavailable'));
      const session = { user: 'Alice', userId: 'alice', email: 'alice@example.com', apiToken: 'session' };
      await expect(f.gateway.searchProjects({ headers: {} }, { destroyed: false }, session, 'hello')).rejects.toThrow('database unavailable');
    } finally { await f.store.close(); }
  });
});
