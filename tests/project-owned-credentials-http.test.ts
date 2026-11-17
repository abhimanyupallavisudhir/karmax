import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { Gateway } from '../src/gateway/server.js';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { AuthorizationService, organizationScope, projectScope } from '../src/platform/authorization.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { WorldRegistry } from '../src/world/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { VaultItems, itemHandle } from '../src/autonomy/vault-items.js';
import { ServiceConnections, type ConnectionBackend } from '../src/integrations/service-connections.js';
import { findFreePortFrom } from '../src/util/ports.js';

/**
 * Project-owned vault items and app connections through the gateway: a Project
 * maintainer — a person, or an autonomous project's Avatār — manages, views and
 * decides requests for the project's own, and nothing else; organization
 * authority keeps working over everything.
 */
let directory: string;
let store: Store;
let server: Awaited<ReturnType<Gateway['listen']>>;
let tokens: TokenAuthority;
let authorization: AuthorizationService;
let broker: CredentialBroker;
let org: string;
let shop: { id: string; name: string };
let lab: { id: string; name: string };
let backend: ConnectionBackend;
let port = 49_620;

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'project-owned-http-'));
  store = await Store.create(':memory:');
  org = (await store.createOrganization({ name: 'Firm', ownerUserId: 'owner' })).id;
  shop = await store.createProject('Shop', {}, org);
  lab = await store.createProject('Lab', {}, org);
  tokens = new TokenAuthority(store);
  authorization = await AuthorizationService.create(store);
  await authorization.grant('system:test', { principalId: 'user:owner', scopeKey: organizationScope(org), profileId: 'superadmin' });
  await authorization.grant('system:test', { principalId: 'user:admin', scopeKey: organizationScope(org), profileId: 'administrator' });
  await authorization.grant('system:test', { principalId: 'user:maintainer', scopeKey: projectScope(shop.id), profileId: 'maintainer' });
  await authorization.grant('system:test', { principalId: 'user:developer', scopeKey: projectScope(shop.id), profileId: 'developer' });
  for (const user of ['admin', 'maintainer', 'developer']) await store.setOrganizationMembership(org, user, 'member');
  broker = new CredentialBroker(new Vault(path.join(directory, 'vault')));
  const worlds = new WorldRegistry();
  const client = { workflow: { getHandle: () => ({ terminate: async () => undefined, signal: async () => undefined,
    executeUpdate: async () => ({}), query: async () => [], describe: async () => ({ status: { name: 'TERMINATED' } }) }) } } as any;
  const api = new KarmaxApi({ store, tokens, worlds, client, taskQueue: 'test', contentDir: directory, authorization });
  backend = { catalog: vi.fn(async () => []), authorize: vi.fn(async () => ({ id: 'ca_shop', url: 'https://connect.composio.dev/link/x' })),
    active: vi.fn(async () => true), session: vi.fn(async () => 'session'), tools: vi.fn(async () => []),
    execute: vi.fn(async () => ({})), disconnect: vi.fn(async () => {}) };
  const connections = new ServiceConnections(store, broker, () => backend);
  await connections.configure('composio-key');
  const gateway = await Gateway.create({ store, tokens, worlds, client, api, authorization, broker, serviceConnections: connections, taskQueue: 'test',
    staticDir: path.resolve('web'), bus: new KarmaxBus(), contributions: new ContributionRegistry(), overlays: new Overlays(),
    agentInfo: { provider: 'mock', reason: 'project-owned credentials' } });
  server = await gateway.listen(await findFreePortFrom(port += 10));
});
afterEach(async () => {
  await server?.close();
  await store?.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

/** A person's console token in one project (or the organization). */
async function person(userId: string, projectId?: string) {
  const caps = await authorization.capabilities(`user:${userId}`, projectId, org);
  return (await tokens.mintPrincipal(`user:${userId}`, caps, projectId, undefined, org)).token;
}
/** A task's agent acting with what `userId` holds in the task's project. */
async function agent(taskId: string, projectId: string, userId: string) {
  const caps = await authorization.capabilities(`user:${userId}`, projectId, org);
  return (await tokens.mint({ taskId, profileId: 'do', role: 'do', principal: `user:${userId}`, projectId,
    organizationId: org, ceiling: caps, grantorCaps: caps })).token;
}
async function call(token: string, method: string, target: string, body?: unknown) {
  const response = await fetch(`${server.url}${target}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
}
const task = (projectId: string, title = 'Work') => store.createTask({ projectId, title, workflow: 'just-do', workflowVersion: '1', params: { prompt: '' } });

describe('vault items a project owns', () => {
  it('a Project maintainer creates, edits, views and deletes the project’s own, and nothing else', async () => {
    const vault = new VaultItems(store, broker, directory, org);
    const shared = await vault.save({ type: 'api-key', label: 'Shared key', secrets: { secret: 'org-secret' } });
    const other = await vault.save({ type: 'api-key', label: 'Lab key', ownerProjectId: lab.id, secrets: { secret: 'lab-secret' } });
    const maintainer = await person('maintainer', shop.id);
    const q = `?projectId=${shop.id}`;

    const created = await call(maintainer, 'POST', `/api/vault/items${q}`, { type: 'api-key', label: 'Shop key', secrets: { secret: 'shop-secret' } });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ label: 'Shop key', ownerProjectId: shop.id });
    const own = created.body.id as string;

    const listed = await call(maintainer, 'GET', `/api/vault/items${q}`);
    expect(listed.status).toBe(200);
    expect(listed.body.map((item: any) => item.label).sort()).toEqual(['Shared key', 'Shop key']);
    expect(listed.body.find((item: any) => item.id === own)).toMatchObject({ ownerProjectId: shop.id, canManage: true, canReveal: true });
    expect(listed.body.find((item: any) => item.id === shared.id)).toMatchObject({ canManage: false, canReveal: false });
    expect(listed.body.find((item: any) => item.id === shared.id).ownerProjectId).toBeUndefined();

    expect((await call(maintainer, 'POST', `/api/vault/items/${own}/reveal${q}`, {})).body).toMatchObject({ value: 'shop-secret' });
    expect((await call(maintainer, 'POST', `/api/vault/items/${shared.id}/reveal${q}`, {})).status).toBe(403);
    expect((await call(maintainer, 'POST', `/api/vault/items/${other.id}/reveal${q}`, {})).status).toBe(404);
    // Loosening its own item's policy is the project's call; editing the organization's is not.
    expect((await call(maintainer, 'POST', `/api/vault/items${q}`, { id: own, policy: { reveal: 'auto' } })).status).toBe(200);
    expect((await call(maintainer, 'POST', `/api/vault/items${q}`, { id: shared.id, label: 'Mine now' })).status).toBe(403);
    expect((await call(maintainer, 'POST', `/api/vault/items${q}`, { id: other.id, label: 'Mine now' })).status).toBe(404);
    // It cannot hand an item to the organization or another project.
    expect((await call(maintainer, 'POST', `/api/vault/items${q}`, { id: own, ownerProjectId: null })).status).toBe(403);
    expect((await call(maintainer, 'POST', `/api/vault/items${q}`, { type: 'note', label: 'Planted', ownerProjectId: lab.id, secrets: { note: 'n' } })).status).toBe(403);
    // Without the project scope the route is the organization vault's.
    expect((await call(await person('maintainer'), 'POST', '/api/vault/items', { type: 'note', label: 'Org note', secrets: { note: 'n' } })).status).toBe(403);
    // A Developer of the project may not manage it.
    expect((await call(await person('developer', shop.id), 'POST', `/api/vault/items${q}`, { id: own, label: 'Renamed' })).status).toBe(403);

    expect((await call(maintainer, 'DELETE', `/api/vault/items/${shared.id}${q}`)).status).toBe(403);
    expect((await call(maintainer, 'DELETE', `/api/vault/items/${own}${q}`)).status).toBe(200);
    expect(await broker.hasHandle(itemHandle(own, 'secret'))).toBe(false);
    expect(await broker.hasHandle(itemHandle(shared.id, 'secret'))).toBe(true);
  });

  it('organization authority keeps working over every project’s items, and may move them', async () => {
    const vault = new VaultItems(store, broker, directory, org);
    const own = await vault.save({ type: 'login', label: 'Shop login', ownerProjectId: shop.id, secrets: { password: 'pw' } });
    const owner = await person('owner');
    const all = await call(owner, 'GET', `/api/vault/items?organizationId=${org}`);
    expect(all.body.find((item: any) => item.id === own.id)).toMatchObject({ ownerProjectId: shop.id, canManage: true, canReveal: true });
    expect((await call(owner, 'POST', `/api/vault/items/${own.id}/reveal?organizationId=${org}`, {})).body.value).toBe('pw');
    // An Administrator manages every item; it views a project's only as that project's maintainer.
    const admin = await person('admin');
    expect((await call(admin, 'POST', `/api/vault/items/${own.id}/reveal?organizationId=${org}`, {})).status).toBe(200);
    expect((await call(admin, 'POST', `/api/vault/items?organizationId=${org}`, { id: own.id, ownerProjectId: lab.id })).body).toMatchObject({ ownerProjectId: lab.id });
    expect((await call(owner, 'POST', `/api/vault/items?organizationId=${org}`, { id: own.id, ownerProjectId: null })).body.ownerProjectId).toBeUndefined();
    const elsewhere = await store.createOrganization({ name: 'Elsewhere', ownerUserId: 'owner' });
    const foreign = await store.createProject('Foreign', {}, elsewhere.id);
    expect((await call(owner, 'POST', `/api/vault/items?organizationId=${org}`, { id: own.id, ownerProjectId: foreign.id })).status).toBe(400);
  });

  it('an agent’s stored credential belongs to its task’s project', async () => {
    const work = await task(shop.id);
    const stored = await call(await agent(work.id, shop.id, 'developer'), 'POST', '/api/vault/store',
      { type: 'login', label: 'Supplier portal', domains: ['supplier.example'], secrets: { password: 'pw' } });
    expect(stored.status).toBe(200);
    expect((await new VaultItems(store, broker, directory, org).get(stored.body.id))?.ownerProjectId).toBe(shop.id);
    // Its project's maintainers can now view it, which only an organization's Super-administrator could before.
    expect((await call(await person('maintainer', shop.id), 'POST', `/api/vault/items/${stored.body.id}/reveal?projectId=${shop.id}`, {})).body.value).toBe('pw');
  });

  it('a Project maintainer decides requests for the project’s items, and may only refuse the rest', async () => {
    const vault = new VaultItems(store, broker, directory, org);
    const own = await vault.save({ type: 'login', label: 'Shop login', ownerProjectId: shop.id, policy: { use: 'ask', reveal: 'ask' }, secrets: { password: 'pw' } });
    const shared = await vault.save({ type: 'login', label: 'Shared login', policy: { use: 'ask', reveal: 'ask' }, secrets: { password: 'pw' } });
    const work = await task(shop.id);
    const labWork = await task(lab.id);
    const asker = await agent(work.id, shop.id, 'developer');
    const ownRequest = (await call(asker, 'POST', '/api/vault/requests', { itemId: own.id, mode: 'use', why: 'log in' })).body;
    const sharedRequest = (await call(asker, 'POST', '/api/vault/requests', { itemId: shared.id, mode: 'use', why: 'log in' })).body;
    expect(ownRequest.status).toBe('needs_approval');
    await vault.request({ taskId: labWork.id, caps: [], itemId: shared.id, mode: 'use', why: 'other project' });
    const maintainer = await person('maintainer', shop.id);
    const q = `?projectId=${shop.id}`;
    // It sees its own project's requests, not another project's.
    expect((await call(maintainer, 'GET', `/api/vault/requests${q}`)).body.map((request: any) => request.taskId)).toEqual([work.id, work.id]);
    expect((await call(await person('developer', shop.id), 'POST', `/api/vault/requests/${ownRequest.requestId}/resolve${q}`, { action: 'task' })).status).toBe(403);
    expect((await call(maintainer, 'POST', `/api/vault/requests/${sharedRequest.requestId}/resolve${q}`, { action: 'once' })).status).toBe(403);
    expect((await call(maintainer, 'POST', `/api/vault/requests/${ownRequest.requestId}/resolve${q}`, { action: 'task' })).body).toMatchObject({ status: 'granted' });
    expect((await vault.access([], work.id, own, 'use')).status).toBe('granted');
    expect((await call(maintainer, 'POST', `/api/vault/requests/${sharedRequest.requestId}/resolve${q}`, { action: 'deny' })).body).toMatchObject({ status: 'denied' });
  });

  it('deleting the project deletes its items and connections, nothing else', async () => {
    const vault = new VaultItems(store, broker, directory, org);
    const own = await vault.save({ type: 'login', label: 'Shop login', ownerProjectId: shop.id, secrets: { password: 'pw' } });
    const shared = await vault.save({ type: 'login', label: 'Shared login', secrets: { password: 'pw' } });
    const maintainer = await person('maintainer', shop.id);
    const connected = await call(maintainer, 'POST', `/api/connections/connect?projectId=${shop.id}`, { toolkit: 'gmail', ownerProjectId: shop.id });
    expect(connected.status).toBe(200);
    expect(connected.body.connection).toMatchObject({ ownerProjectId: shop.id });
    expect((await call(maintainer, 'DELETE', `/api/projects/${shop.id}`, { confirmName: 'Shop' })).status).toBe(200);
    expect((await vault.list()).map((item) => item.id)).toEqual([shared.id]);
    expect(await broker.hasHandle(itemHandle(own.id, 'password'))).toBe(false);
    expect(await store.kvEntries('service-connection:')).toEqual([]);
    expect(backend.disconnect).toHaveBeenCalledWith('ca_shop');
  });
});

describe('app connections a project owns', () => {
  it('its maintainers — people or agents — connect and disconnect them; others may not', async () => {
    const maintainer = await person('maintainer', shop.id);
    const q = `?projectId=${shop.id}`;
    const started = await call(maintainer, 'POST', `/api/connections/connect${q}`, { toolkit: 'gmail', ownerProjectId: shop.id });
    expect(started.body).toMatchObject({ connection: { ownerProjectId: shop.id, status: 'connecting' }, url: expect.stringMatching(/^https:\/\/connect\.composio\.dev\//) });
    const id = started.body.connection.id;
    // A developer may neither connect for the project nor touch its account.
    expect((await call(await person('developer', shop.id), 'POST', `/api/connections/connect${q}`, { toolkit: 'slack', ownerProjectId: shop.id })).status).toBe(403);
    expect((await call(await person('developer', shop.id), 'POST', `/api/connections/${id}/disconnect${q}`, {})).status).toBe(403);
    // A maintainer of another project neither.
    await authorization.grant('system:test', { principalId: 'user:labbie', scopeKey: projectScope(lab.id), profileId: 'maintainer' });
    expect((await call(await person('labbie', lab.id), 'POST', `/api/connections/connect?projectId=${lab.id}`, { toolkit: 'slack', ownerProjectId: shop.id })).status).toBe(403);
    expect((await call(maintainer, 'POST', `/api/connections/${id}/refresh${q}`, {})).body).toMatchObject({ status: 'active' });
    const listed = await call(maintainer, 'GET', `/api/connections${q}`);
    expect(listed.body.find((c: any) => c.id === id)).toMatchObject({ canManage: true });
    // An agent holding Project maintainer (an autonomous project's Avatār) manages it too.
    const work = await task(shop.id);
    const avatar = await agent(work.id, shop.id, 'maintainer');
    expect((await call(avatar, 'POST', `/api/connections/${id}/disconnect`, {})).body).toMatchObject({ status: 'disconnected' });
    expect((await call(avatar, 'POST', '/api/connections/connect', { id, ownerProjectId: shop.id })).status).toBe(200);
    // Sharing it with another project is refused.
    expect((await call(maintainer, 'PUT', `/api/connections/${id}/access${q}`, { projectIds: [shop.id, lab.id] })).status).toBe(403);
  });
});
