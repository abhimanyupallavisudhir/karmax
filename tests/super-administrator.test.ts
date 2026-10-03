import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Gateway } from '../src/gateway/server.js';
import { KarmaxApi } from '../src/platform/api.js';
import { AuthorizationService, DEFAULT_AUTHORIZATION_PROFILES, organizationScope } from '../src/platform/authorization.js';
import { SHIPPED_BUILTIN_PROFILES } from '../src/platform/builtin-profile-history.js';
import { allows } from '../src/platform/capabilities.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { Store } from '../src/store/db.js';
import { Overlays } from '../src/store/overlays.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { VaultItems } from '../src/autonomy/vault-items.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { WorldRegistry } from '../src/world/registry.js';
import { findFreePortFrom } from '../src/util/ports.js';

const DANGEROUS = ['credential:reveal', 'payment:write', 'organization:delete'];
const caps = (id: string) => DEFAULT_AUTHORIZATION_PROFILES.find((profile) => profile.id === id)!.capabilities;

let nextPort = 51_300;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe('Super-administrator authorization level', () => {
  it('sits between Administrator and God and alone holds the dangerous organization powers', async () => {
    const store = await Store.create(':memory:');
    try {
      const authz = await AuthorizationService.create(store);
      expect((await authz.profiles()).map((p) => p.id).sort())
        .toEqual(['administrator', 'developer', 'god', 'maintainer', 'superadmin', 'viewer']);
      const admin = (await authz.profile('administrator'))!.capabilities;
      const superadmin = (await authz.profile('superadmin'))!;
      expect(superadmin.name).toBe('Super-administrator');
      for (const capability of DANGEROUS) {
        expect(allows(admin, capability), capability).toBe(false);
        expect(allows(superadmin.capabilities, capability), capability).toBe(true);
      }
      // Everything else an Administrator could do, a Super-administrator can too.
      for (const capability of admin) expect(allows(superadmin.capabilities, capability), capability).toBe(true);
      // Administrators keep day-to-day credential and payment work.
      for (const capability of ['credential:read', 'credential:write', 'use-credential:*', 'payment:read', 'use-card:*', 'organization:edit'])
        expect(allows(admin, capability), capability).toBe(true);
      expect(allows(superadmin.capabilities, 'workflow:install')).toBe(false);
      expect(allows(superadmin.capabilities, 'settings:write')).toBe(false);

      const organization = await store.createOrganization({ name: 'Acme' });
      await store.createProject('P', {}, organization.id);
      await expect(authz.assertCanGrantSelection('user:root', organization.id, { level: 'superadmin', scope: 'projects', projectIds: ['x'] }))
        .rejects.toThrow(/Super-administrator requires organization scope/);
    } finally { await store.close(); }
  });

  it('makes organization owners Super-administrators and leaves other Administrators where they are', async () => {
    const store = await Store.create(':memory:');
    try {
      const organization = await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
      await store.setOrganizationMembership(organization.id, 'admin', 'member');
      // The state an existing installation is in: the previous Administrator
      // definition, owners and other members granted Administrator.
      const previous = [...SHIPPED_BUILTIN_PROFILES].reverse().find((version) => version.id === 'administrator'
        && version.capabilities.includes('credential:*'))!;
      await store.setAuthorizationProfile('global', { id: 'administrator', name: 'Administrator', builtin: true,
        description: previous.description, capabilities: [...previous.capabilities] } as any);
      for (const principalId of ['user:owner', 'user:admin'])
        await store.setPrincipalGrant(principalId, organizationScope(organization.id),
          { principalId, scopeKey: organizationScope(organization.id), profileId: 'administrator', grantedBy: 'test', grantedAt: 1 } as any);

      const authz = await AuthorizationService.create(store);
      expect(allows((await authz.profile('administrator'))!.capabilities, 'credential:reveal')).toBe(false);
      expect(await authz.selectionForPrincipal('user:owner', organization.id)).toEqual({ level: 'superadmin', scope: 'organization' });
      expect(await authz.selectionForPrincipal('user:admin', organization.id)).toEqual({ level: 'administrator', scope: 'organization' });
      expect(allows(await authz.capabilities('user:owner', undefined, organization.id), 'credential:reveal')).toBe(true);
      expect(allows(await authz.capabilities('user:admin', undefined, organization.id), 'credential:reveal')).toBe(false);

      // A new organization's owner starts as a Super-administrator.
      const other = await store.createOrganization({ name: 'Beta', ownerUserId: 'founder' });
      await authz.bootstrapOrganizationOwner('system:test', 'founder', other.id);
      expect(await authz.selectionForPrincipal('user:founder', other.id)).toEqual({ level: 'superadmin', scope: 'organization' });
    } finally { await store.close(); }
  });

  it('never lets an Administrator grant, or take away, authority they do not hold', async () => {
    const store = await Store.create(':memory:');
    try {
      const authz = await AuthorizationService.create(store);
      const organization = await store.createOrganization({ name: 'Acme' });
      await store.createProject('P', {}, organization.id);
      const scope = organizationScope(organization.id);
      await authz.grant('test', { principalId: 'user:admin', scopeKey: scope, profileId: 'administrator' });
      await authz.grant('test', { principalId: 'user:owner', scopeKey: scope, profileId: 'superadmin' });
      await authz.grant('test', { principalId: 'user:dev', scopeKey: scope, profileId: 'developer' });

      await expect(authz.replacePrincipalAuthorization('user:admin', 'user:dev', organization.id, { level: 'superadmin', scope: 'organization' }))
        .rejects.toThrow(/you cannot grant/);
      await expect(authz.replacePrincipalAuthorization('user:admin', 'user:admin', organization.id, { level: 'superadmin', scope: 'organization' }))
        .rejects.toThrow(/you cannot grant/);
      // Demoting someone whose authority exceeds yours is a way of taking it.
      await expect(authz.replacePrincipalAuthorization('user:admin', 'user:owner', organization.id, { level: 'viewer', scope: 'organization' }))
        .rejects.toThrow(/cannot change the authorization of someone who holds more than you/);
      expect(await authz.selectionForPrincipal('user:owner', organization.id)).toEqual({ level: 'superadmin', scope: 'organization' });
      // Within their own authority they still manage people.
      await authz.replacePrincipalAuthorization('user:admin', 'user:dev', organization.id, { level: 'maintainer', scope: 'organization' });
      expect(await authz.selectionForPrincipal('user:dev', organization.id)).toEqual({ level: 'maintainer', scope: 'organization' });
      await authz.replacePrincipalAuthorization('user:owner', 'user:admin', organization.id, { level: 'superadmin', scope: 'organization' });
      expect(await authz.selectionForPrincipal('user:admin', organization.id)).toEqual({ level: 'superadmin', scope: 'organization' });
    } finally { await store.close(); }
  });
});

async function vaultGateway() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-superadmin-'));
  const store = await Store.create(':memory:');
  const organization = await store.createOrganization({ name: 'Acme Corp', ownerUserId: 'owner' });
  const project = await store.createProject('Website', {}, organization.id);
  const tokens = new TokenAuthority(store);
  const worlds = new WorldRegistry();
  const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
  const client = { workflow: { getHandle: () => ({}) } } as any;
  const api = new KarmaxApi({ store, tokens, client, worlds, broker, taskQueue: 'test' } as any);
  const authorization = await AuthorizationService.create(store);
  const gateway = await Gateway.create({ authorization, api, store, tokens, client, worlds, broker,
    taskQueue: 'test', staticDir: 'web', bus: new KarmaxBus(), contributions: new ContributionRegistry(),
    overlays: new Overlays(), agentInfo: { provider: 'mock', reason: 'super-administrator test' } } as any);
  const server = await gateway.listen(await findFreePortFrom(nextPort += 10));
  cleanups.push(async () => { await server.close(); await store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const vault = new VaultItems(store, broker, dir, organization.id);
  const agent = async (level: 'administrator' | 'superadmin') => {
    const task = await store.createTask({ projectId: project.id, title: `${level} task`, workflow: 'just-do', workflowVersion: '1', params: { prompt: '' } });
    const { token } = await tokens.mint({ taskId: task.id, projectId: project.id, organizationId: organization.id, principal: 'user:owner',
      profileId: level, ceiling: ['*'], grantorCaps: caps(level) });
    const call = (route: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => fetch(`${server.url}${route}`, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { task, call };
  };
  return { store, organization, project, vault, agent, url: server.url };
}

describe('vault read access needs Super-administrator', () => {
  it('lets only a Super-administrator agent reveal, approve, or loosen what protects a secret', async () => {
    const { vault, agent, organization } = await vaultGateway();
    const login = await vault.save({ type: 'login', label: 'Bank', domains: ['bank.example'], username: 'alice',
      policy: { use: 'ask', reveal: 'never' }, secrets: { password: 'bank-password-123' } });
    const admin = await agent('administrator');
    const superadmin = await agent('superadmin');

    // The console disables View for whoever cannot reveal.
    expect((await (await admin.call('/api/vault/items')).json() as any[]).map((item) => item.canReveal)).toEqual([false]);
    expect((await (await superadmin.call('/api/vault/items')).json() as any[]).map((item) => item.canReveal)).toEqual([true]);
    const reveal = await admin.call(`/api/vault/items/${login.id}/reveal`, { field: 'password' });
    expect(reveal.status).toBe(403);
    const refusal = (await reveal.json() as any).error as string;
    expect(refusal).toContain('credential:reveal');
    expect(refusal).toContain(`organization "Acme Corp" (${organization.id})`);
    expect(refusal).toMatch(/Super-administrator/);
    const revealed = await superadmin.call(`/api/vault/items/${login.id}/reveal`, { field: 'password' });
    expect(revealed.status).toBe(200);
    expect((await revealed.json() as any).value).toBe('bank-password-123');

    // Loosening a policy or moving where a password can be filled hands it out.
    const loosen = await admin.call('/api/vault/items', { id: login.id, type: 'login', label: 'Bank', policy: { use: 'auto', reveal: 'auto' } });
    expect(loosen.status).toBe(403);
    expect((await loosen.json() as any).error).toContain('credential:reveal');
    const redirect = await admin.call('/api/vault/items', { id: login.id, type: 'login', label: 'Bank', domains: ['attacker.example'] });
    expect(redirect.status).toBe(403);
    expect((await vault.get(login.id))!).toMatchObject({ domains: ['bank.example'], policy: { use: 'ask', reveal: 'never' } });
    // Ordinary administration still works.
    const renamed = await admin.call('/api/vault/items', { id: login.id, type: 'login', label: 'Bank (personal)', policy: { use: 'ask', reveal: 'never' } });
    expect(renamed.status).toBe(200);
    expect((await vault.get(login.id))!.label).toBe('Bank (personal)');
    const tightened = await superadmin.call('/api/vault/items', { id: login.id, type: 'login', label: 'Bank', policy: { use: 'auto', reveal: 'ask' } });
    expect(tightened.status).toBe(200);
    await admin.call('/api/vault/items', { id: login.id, type: 'login', label: 'Bank', policy: { use: 'ask', reveal: 'never' } });
    expect((await vault.get(login.id))!.policy).toEqual({ use: 'ask', reveal: 'never' });

    // Approving a credential request grants access, so it needs the same authority.
    const request = await vault.request({ taskId: admin.task.id, caps: [], itemId: login.id, mode: 'use', why: 'log in' });
    const approve = await admin.call(`/api/vault/requests/${request.requestId}/resolve`, { action: 'once' });
    expect(approve.status).toBe(403);
    expect((await approve.json() as any).error).toContain('credential:reveal');
    expect((await vault.access([], admin.task.id, login, 'use')).status).not.toBe('granted');
    const deny = await admin.call(`/api/vault/requests/${request.requestId}/resolve`, { action: 'deny' });
    expect(deny.status).toBe(200);
    const second = await vault.request({ taskId: admin.task.id, caps: [], itemId: login.id, mode: 'use', why: 'log in' });
    expect((await superadmin.call(`/api/vault/requests/${second.requestId}/resolve`, { action: 'once' })).status).toBe(200);
  });

  it('keeps "ask" a request a person sees, while only a Super-administrator can read past it', async () => {
    const { vault, agent } = await vaultGateway();
    const key = await vault.save({ type: 'api-key', label: 'Stripe', policy: { use: 'ask', reveal: 'ask' }, secrets: { secret: 'sk_live_super_secret' } });
    const open = await vault.save({ type: 'api-key', label: 'Search', policy: { use: 'auto', reveal: 'auto' }, secrets: { secret: 'search-key-value' } });
    const admin = await agent('administrator');
    const superadmin = await agent('superadmin');
    for (const caller of [admin, superadmin])
      expect((await (await caller.call('/api/vault/resolve', { itemId: key.id, field: 'secret' })).json() as any).status).toBe('needs_approval');
    expect((await (await admin.call('/api/vault/resolve', { itemId: open.id, field: 'secret' })).json() as any))
      .toMatchObject({ status: 'granted', value: 'search-key-value' });
    expect((await admin.call(`/api/vault/items/${key.id}/reveal`, { field: 'secret' })).status).toBe(403);
    expect((await (await superadmin.call(`/api/vault/items/${key.id}/reveal`, { field: 'secret' })).json() as any).value).toBe('sk_live_super_secret');
  });

  it('keeps an Administrator from pointing a password-store connector somewhere else', async () => {
    const { agent } = await vaultGateway();
    const admin = await agent('administrator');
    for (const [action, body] of [['connect', { secret: '{}' }], ['config', { writeBack: true }]] as const) {
      const response = await admin.call(`/api/vault/connectors/pass-git/${action}`, body);
      expect(response.status, action).toBe(403);
      expect((await response.json() as any).error, action).toContain('credential:reveal');
    }
  });

  it('reserves deleting the organization for a Super-administrator', async () => {
    const { agent, organization, store } = await vaultGateway();
    const admin = await agent('administrator');
    const response = await admin.call(`/api/organizations/${organization.id}`, { confirmSlug: organization.slug }, 'DELETE');
    expect(response.status).toBe(403);
    expect((await response.json() as any).error).toContain('organization:delete');
    expect(await store.getOrganization(organization.id)).toBeDefined();
  });
});

describe('capability refusals say where the capability is missing', () => {
  it('names the project and organization, the caller’s level there, and which level has it', async () => {
    const store = await Store.create(':memory:');
    try {
      const tokens = new TokenAuthority(store);
      const organization = await store.createOrganization({ name: 'Acme Corp' });
      const project = await store.createProject('Website', {}, organization.id);
      const { token } = await tokens.mintPrincipal('user:alice', caps('viewer'), project.id, 60_000, organization.id);
      const checked = await tokens.check(token, 'task:create', { projectId: project.id });
      expect(checked.ok).toBe(false);
      expect(checked.reason).toBe(`missing capability task:create in project "Website" (${project.id}) of organization "Acme Corp" (${organization.id})`);
      expect(checked.missing).toBe('task:create');

      const unscoped = await tokens.mintPrincipal('user:alice', [], undefined, 60_000);
      expect((await tokens.check(unscoped.token, 'task:create')).reason)
        .toBe('missing capability task:create across the installation (the request names no project or organization)');
    } finally { await store.close(); }
  });
});
