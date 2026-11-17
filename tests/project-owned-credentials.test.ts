import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { VaultItems, itemHandle } from '../src/autonomy/vault-items.js';
import { organizationScope } from '../src/autonomy/vault-keys.js';
import { resolveVaultScopes } from '../src/autonomy/vault-scopes.js';
import { AuthorizationService, organizationScope as orgGrantScope, projectScope } from '../src/platform/authorization.js';
import { allows } from '../src/platform/capabilities.js';
import { ownerAuthority } from '../src/platform/owner-authority.js';
import { ProjectTransfers } from '../src/platform/project-transfer.js';
import { ServiceConnections, type ConnectionBackend } from '../src/integrations/service-connections.js';

/**
 * Vault items and app connections a project owns (wiki features/vault-encryption,
 * features/service-connections): its maintainers manage, view and decide them,
 * only its tasks use them, and they go when the project goes. Organization
 * authority keeps working over everything; the encryption key stays the
 * organization's.
 */
const dirs: string[] = [];
const stores: Store[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'project-owned-'));
  dirs.push(home);
  const store = await Store.create(':memory:');
  stores.push(store);
  const organization = await store.createOrganization({ name: 'Firm', ownerUserId: 'owner' });
  const org = organization.id;
  const project = await store.createProject('Shop', {}, org);
  const other = await store.createProject('Lab', {}, org);
  const broker = new CredentialBroker(new Vault(path.join(home, 'vault')));
  const task = (projectId: string, title = 'Work') => store.createTask({ projectId, title, workflow: 'just-do', workflowVersion: '1', params: { prompt: '' } });
  return { home, store, org, project, other, broker, task };
}

describe('who may manage a credential: its owner', () => {
  it('keeps the organization vault out of a project grant, and gives a project maintainer authority over the project’s own', async () => {
    const f = await fixture();
    const authorization = await AuthorizationService.create(f.store);
    await authorization.grant('system:test', { principalId: 'user:maintainer', scopeKey: projectScope(f.project.id), profileId: 'maintainer' });
    await authorization.grant('system:test', { principalId: 'user:developer', scopeKey: projectScope(f.project.id), profileId: 'developer' });
    await authorization.grant('system:test', { principalId: 'user:admin', scopeKey: orgGrantScope(f.org), profileId: 'administrator' });
    await authorization.grant('system:test', { principalId: 'user:super', scopeKey: orgGrantScope(f.org), profileId: 'superadmin' });
    const maintainer = await authorization.capabilities('user:maintainer', f.project.id, f.org);
    // The ceiling is unchanged: credential:write/reveal mean the whole organization's vault.
    expect(allows(maintainer, 'credential:write')).toBe(false);
    expect(allows(maintainer, 'credential:reveal')).toBe(false);
    for (const power of ['manage', 'reveal'] as const) {
      expect(ownerAuthority(maintainer, power, f.project.id, f.project.id)).toBe(true);
      expect(ownerAuthority(maintainer, power, undefined, f.project.id)).toBe(false);
      expect(ownerAuthority(maintainer, power, f.other.id, f.project.id)).toBe(false);
      // Caps held in one project say nothing about another's items.
      expect(ownerAuthority(maintainer, power, f.project.id, f.other.id)).toBe(false);
    }
    const developer = await authorization.capabilities('user:developer', f.project.id, f.org);
    expect(ownerAuthority(developer, 'manage', f.project.id, f.project.id)).toBe(false);
    const admin = await authorization.capabilities('user:admin', undefined, f.org);
    expect(ownerAuthority(admin, 'manage', undefined, undefined)).toBe(true);
    expect(ownerAuthority(admin, 'reveal', undefined, undefined)).toBe(false);
    // An Administrator maintains every project, so it reads their own items, never the organization's.
    expect(ownerAuthority(admin, 'reveal', f.project.id, undefined)).toBe(true);
    const superadmin = await authorization.capabilities('user:super', undefined, f.org);
    for (const owner of [undefined, f.project.id, f.other.id]) expect(ownerAuthority(superadmin, 'reveal', owner, undefined)).toBe(true);
  });
});

describe('vault items a project owns', () => {
  it('are seen and used by that project’s tasks only, whatever their grant', async () => {
    const f = await fixture();
    const organization = new VaultItems(f.store, f.broker, f.home, f.org);
    const shared = await organization.save({ type: 'api-key', label: 'Shared key', envVar: 'SHARED_KEY', secrets: { secret: 'shared' } });
    const own = await organization.save({ type: 'api-key', label: 'Shop key', envVar: 'SHOP_KEY', ownerProjectId: f.project.id, secrets: { secret: 'shop' } });
    expect(own.ownerProjectId).toBe(f.project.id);
    expect((await organization.get(own.id))?.ownerProjectId).toBe(f.project.id);
    // The organization sees everything; each project sees the organization's and its own.
    expect((await organization.list()).map((item) => item.label).sort()).toEqual(['Shared key', 'Shop key']);
    const shop = new VaultItems(f.store, f.broker, f.home, f.org, undefined, f.project.id);
    const lab = new VaultItems(f.store, f.broker, f.home, f.org, undefined, f.other.id);
    expect((await shop.list()).map((item) => item.label).sort()).toEqual(['Shared key', 'Shop key']);
    expect((await lab.list()).map((item) => item.label)).toEqual(['Shared key']);
    expect(await lab.get(own.id)).toBeUndefined();

    const shopTask = await f.task(f.project.id);
    const labTask = await f.task(f.other.id);
    // Even an organization-wide instance refuses another project's task.
    expect(await organization.covered(['use-credential:*'], shopTask.id, own)).toBe(true);
    expect(await organization.covered(['use-credential:*'], labTask.id, own)).toBe(false);
    expect(await organization.covered([`use-credential:item:${own.id}`], labTask.id, own)).toBe(false);
    expect((await organization.access(['use-credential:*'], labTask.id, own, 'use')).status).toBe('denied');
    expect(await lab.envFor(labTask.id, ['use-credential:*'], path.join(f.home, 'keys'))).toEqual({ SHARED_KEY: 'shared' });
    expect(await shop.envFor(shopTask.id, ['use-credential:*'], path.join(f.home, 'keys'))).toEqual({ SHARED_KEY: 'shared', SHOP_KEY: 'shop' });

    // Asking for it by id from the other project finds nothing, and nobody can bind it there.
    const asked = await lab.request({ taskId: labTask.id, caps: [], itemId: own.id, mode: 'use', why: 'deploy' });
    expect(asked.status).toBe('not_in_vault');
    const missing = await lab.request({ taskId: labTask.id, caps: [], domain: 'shop.example', mode: 'use', why: 'deploy' });
    await expect(organization.resolve(missing.requestId!, { action: 'task', by: 'user:owner', itemId: own.id }))
      .rejects.toThrow(/belongs to another project/);
  });

  it('ask the project’s maintainers too when a task wants one', async () => {
    const f = await fixture();
    await f.store.setOrganizationMembership(f.org, 'maintainer', 'member');
    const authorization = await AuthorizationService.create(f.store);
    await authorization.grant('system:test', { principalId: 'user:maintainer', scopeKey: projectScope(f.project.id), profileId: 'maintainer' });
    const vault = new VaultItems(f.store, f.broker, f.home, f.org);
    const shared = await vault.save({ type: 'login', label: 'Shared', policy: { use: 'ask', reveal: 'ask' }, secrets: { password: 'pw' } });
    const own = await vault.save({ type: 'login', label: 'Shop', ownerProjectId: f.project.id, policy: { use: 'ask', reveal: 'ask' }, secrets: { password: 'pw' } });
    const work = await f.store.createTask({ projectId: f.project.id, title: 'Work', workflow: 'just-do', workflowVersion: '1', params: { prompt: '' }, createdBy: 'owner' } as any);
    await vault.request({ taskId: work.id, caps: [], itemId: shared.id, mode: 'use', why: 'x' });
    expect(await f.store.listInbox('maintainer', f.org)).toEqual([]);
    await vault.request({ taskId: work.id, caps: [], itemId: own.id, mode: 'use', why: 'x' });
    expect((await f.store.listInbox('maintainer', f.org)).map((row) => row.kind)).toEqual(['approval-requested']);
  });

  it('keep the organization’s encryption key, and the scope migration attributes them to it', async () => {
    const f = await fixture();
    const own = await new VaultItems(f.store, f.broker, f.home, f.org)
      .save({ type: 'login', label: 'Shop login', ownerProjectId: f.project.id, secrets: { password: 'pw' } });
    const scopes = await resolveVaultScopes(f.store, [itemHandle(own.id, 'password')]);
    expect(scopes.get(itemHandle(own.id, 'password'))).toBe(organizationScope(f.org));
  });

  it('go with their project: secrets, requests and grants, never the organization’s or another project’s', async () => {
    const f = await fixture();
    const vault = new VaultItems(f.store, f.broker, f.home, f.org);
    const shared = await vault.save({ type: 'login', label: 'Shared', secrets: { password: 'shared' } });
    const own = await vault.save({ type: 'login', label: 'Shop', ownerProjectId: f.project.id, secrets: { password: 'shop' } });
    const lab = await vault.save({ type: 'login', label: 'Lab', ownerProjectId: f.other.id, secrets: { password: 'lab' } });
    const shopTask = await f.task(f.project.id);
    const labTask = await f.task(f.other.id);
    const shopRequest = await vault.request({ taskId: shopTask.id, caps: [], itemId: shared.id, mode: 'use', why: 'x' });
    await vault.request({ taskId: labTask.id, caps: [], itemId: shared.id, mode: 'use', why: 'x' });
    await vault.resolve(shopRequest.requestId!, { action: 'task', by: 'user:owner' });
    const { deleteProjectCredentials } = await import('../src/autonomy/cleanup.js');
    await deleteProjectCredentials(f.store, f.broker, f.org, f.project.id, { home: f.home });
    await deleteProjectCredentials(f.store, f.broker, f.org, f.project.id, { home: f.home });
    expect((await vault.list()).map((item) => item.label).sort()).toEqual(['Lab', 'Shared']);
    expect(await f.broker.hasHandle(itemHandle(own.id, 'password'))).toBe(false);
    expect(await f.broker.hasHandle(itemHandle(shared.id, 'password'))).toBe(true);
    expect(await f.broker.hasHandle(itemHandle(lab.id, 'password'))).toBe(true);
    expect((await vault.requests()).map((request) => request.taskId)).toEqual([labTask.id]);
    expect(await vault.extensions(shopTask.id)).toEqual([]);
  });

  it('block moving the project to another organization, whose key could not open them', async () => {
    const f = await fixture();
    const destination = await f.store.createOrganization({ name: 'Elsewhere', ownerUserId: 'owner' });
    await new VaultItems(f.store, f.broker, f.home, f.org).save({ type: 'note', label: 'Shop note', ownerProjectId: f.project.id, secrets: { note: 'n' } });
    const transfers = new ProjectTransfers(f.store, { principal: 'user:owner', authorize: async () => undefined, workflowClosed: async () => true });
    const preview = await transfers.preview(f.project.id, destination.id);
    expect(preview.blockers.map((blocker) => blocker.code)).toContain('vault');
    expect((await transfers.preview(f.other.id, destination.id)).blockers.map((blocker) => blocker.code)).not.toContain('vault');
  });
});

describe('app connections a project owns', () => {
  async function connections() {
    const f = await fixture();
    const backend: ConnectionBackend = { catalog: vi.fn(async () => [{ slug: 'gmail', name: 'Gmail' }]),
      authorize: vi.fn(async () => ({ id: 'ca_shop', url: 'https://connect.composio.dev/link/secret' })),
      active: vi.fn(async () => true), session: vi.fn(async () => 'session-private'),
      tools: vi.fn(async () => [{ slug: 'GMAIL_FETCH_EMAILS', name: 'Fetch' }]),
      execute: vi.fn(async () => ({ successful: true })), disconnect: vi.fn(async () => {}) };
    const service = new ServiceConnections(f.store, f.broker, () => backend);
    await service.configure('project-key-private');
    return { ...f, backend, service };
  }

  it('is usable by the project’s tasks only, is not the person’s who signed in, and cannot be shared out', async () => {
    const f = await connections();
    const started = await f.service.connect(f.org, 'alice', { toolkit: 'gmail', ownerProjectId: f.project.id });
    expect(started.connection).toMatchObject({ ownerProjectId: f.project.id, projectIds: [f.project.id] });
    expect(started.connection.ownerId).toBeUndefined();
    await f.service.refresh(f.org, started.connection.id);
    const shopTask = await f.task(f.project.id);
    const labTask = await f.task(f.other.id);
    expect((await f.service.list(f.org, { taskId: shopTask.id, projectId: f.project.id })).map((c) => c.id)).toEqual([started.connection.id]);
    expect(await f.service.list(f.org, { taskId: labTask.id, projectId: f.other.id })).toEqual([]);
    await expect(f.service.execute(f.org, started.connection.id, shopTask.id, f.project.id, 'GMAIL_FETCH_EMAILS', {})).resolves.toBeDefined();
    await expect(f.service.execute(f.org, started.connection.id, labTask.id, f.other.id, 'GMAIL_FETCH_EMAILS', {})).rejects.toThrow(/not been shared/);
    // Not alice's: it is not among her accounts to reuse, and leaving the organization does not take it away.
    expect(await f.service.reusable(f.org, 'alice', 'gmail')).toEqual([]);
    await expect(f.service.share(f.org, started.connection.id, 'alice', [f.other.id])).rejects.toThrow(/belongs to the project/);
    // The provider account belongs to the project, not to whoever signed in.
    const identity = vi.mocked(f.backend.authorize).mock.calls[0]![0];
    await f.service.connect(f.org, 'alice', { toolkit: 'gmail' });
    expect(vi.mocked(f.backend.authorize).mock.calls[1]![0]).not.toBe(identity);
    // Any maintainer (checked by the gateway) may disconnect it, people and agents alike.
    const disconnected = await f.service.disconnect(f.org, started.connection.id, undefined);
    expect(disconnected.status).toBe('disconnected');
    expect(f.backend.disconnect).toHaveBeenCalledWith('ca_shop');
  });

  it('turns a task’s request into the project’s account when connected for the project', async () => {
    const f = await connections();
    const shopTask = await f.task(f.project.id);
    const request = await f.service.request(f.org, 'gmail', shopTask.id, 'do', 'Read the shop inbox');
    await expect(f.service.connect(f.org, undefined, { id: request.id, ownerProjectId: f.other.id }))
      .rejects.toThrow(/its own project/);
    const result = await f.service.connect(f.org, undefined, { id: request.id, ownerProjectId: f.project.id });
    expect(result.connection).toMatchObject({ id: request.id, ownerProjectId: f.project.id, taskId: shopTask.id, status: 'connecting' });
    await f.service.refresh(f.org, request.id);
    const peer = await f.task(f.project.id, 'Peer');
    expect((await f.service.list(f.org, { taskId: peer.id, projectId: f.project.id })).map((c) => c.id)).toEqual([request.id]);
  });

  it('go with their project; a person’s account shared with it stays theirs', async () => {
    const f = await connections();
    const own = (await f.service.connect(f.org, 'alice', { toolkit: 'gmail', ownerProjectId: f.project.id })).connection;
    await f.service.refresh(f.org, own.id);
    vi.mocked(f.backend.authorize).mockResolvedValueOnce({ id: 'ca_alice', url: 'https://connect.composio.dev/link/alice' });
    const personal = (await f.service.connect(f.org, 'alice', { toolkit: 'slack' })).connection;
    await f.service.refresh(f.org, personal.id);
    await f.service.share(f.org, personal.id, 'alice', [f.project.id, f.other.id]);
    const shopTask = await f.task(f.project.id);
    const open = await f.service.request(f.org, 'notion', shopTask.id, 'do', 'Read docs');
    const { deleteProjectCredentials } = await import('../src/autonomy/cleanup.js');
    await deleteProjectCredentials(f.store, f.broker, f.org, f.project.id, { home: f.home, connections: f.service });
    const left = await f.service.all();
    expect(left.map((c) => c.id)).toEqual([personal.id]);
    expect(left[0]!.projectIds).toEqual([f.other.id]);
    expect(f.backend.disconnect).toHaveBeenCalledWith('ca_shop');
    expect(f.backend.disconnect).not.toHaveBeenCalledWith('ca_alice');
    expect(left.some((c) => c.id === open.id)).toBe(false);
  });
});
