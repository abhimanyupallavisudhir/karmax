import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { Gateway } from '../src/gateway/server.js';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { AuthorizationService } from '../src/platform/authorization.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { WorldRegistry } from '../src/world/registry.js';
import { MemoryWorldProvider } from '../src/world/memory.js';
import { Overlays } from '../src/store/overlays.js';
import { findFreePortFrom } from '../src/util/ports.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { Vault } from '../src/autonomy/vault.js';
import { VaultItems, itemHandle } from '../src/autonomy/vault-items.js';
import { ObjectSnapshotEngine, ProjectResourceService } from '../src/world/resources.js';
import type { World } from '../src/world/types.js';
import { INSTALLATION_SCOPE } from '../src/autonomy/vault-keys.js';

// A project resource once stored whatever vault handles a request named, and
// resolved, overwrote and deleted them with a capability it granted itself. The
// installation's own secrets share that vault under fixed names, so anyone
// who could edit a project's settings could read the GitHub App's private key
// into a task, overwrite it, or delete it (AU-40).
describe('project resource credentials', () => {
  const PLATFORM_HANDLE = 'github-app:private-key';
  const PLATFORM_SECRET = 'PLATFORM-GITHUB-APP-PRIVATE-KEY';
  let dir: string, store: Store, broker: CredentialBroker, resources: ProjectResourceService, worlds: WorldRegistry;
  let server: { url: string; close(): Promise<void> }, headers: Record<string, string>;
  let project: Awaited<ReturnType<Store['createProject']>>, world: World | undefined;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-resource-ownership-'));
    store = await Store.create(':memory:');
    worlds = new WorldRegistry(); worlds.register(new MemoryWorldProvider());
    broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    await broker.registerHandle(PLATFORM_HANDLE, PLATFORM_SECRET, INSTALLATION_SCOPE);
    const objects = new Map<string, Buffer>();
    resources = new ProjectResourceService(store, worlds, new ObjectSnapshotEngine({
      put: async (key: string, bytes: Buffer) => { objects.set(key, bytes); },
      get: async (key: string) => objects.get(key)!, delete: async (key: string) => { objects.delete(key); },
    }, broker), broker);
    const tokens = new TokenAuthority();
    const client = { workflow: { getHandle: () => ({ query: async () => [], terminate: async () => {} }) } } as any;
    const api = new KarmaxApi({ store, tokens, worlds, client, taskQueue: 'test', contentDir: dir });
    const gateway = await Gateway.create({ store, tokens, worlds, client, api, broker, resources,
      authorization: await AuthorizationService.create(store), taskQueue: 'test', staticDir: path.resolve('web'),
      bus: new KarmaxBus(), contributions: new ContributionRegistry(), overlays: new Overlays(),
      agentInfo: { provider: 'mock', reason: 'resource credential ownership' } });
    server = await gateway.listen(await findFreePortFrom(49120));
    const { token } = await (await fetch(`${server.url}/api/session`)).json() as { token: string };
    headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    project = await store.createProject('Owned secrets');
  });
  afterEach(async () => {
    await server?.close(); await world?.destroy(); world = undefined; await store?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const createSecret = async (name = 'APP_TOKEN') => {
    const response = await fetch(`${server.url}/api/projects/${project.id}/resources`, { method: 'POST', headers,
      body: JSON.stringify({ name, driver: 'secret@1', target: { kind: 'environment', name }, secret: 'own-value' }) });
    expect(response.status).toBe(200);
    return (await response.json() as { id: string }).id;
  };
  const patch = (id: string, body: unknown) => fetch(`${server.url}/api/projects/${project.id}/resources/${id}`,
    { method: 'PATCH', headers, body: JSON.stringify(body) });
  // What a record looks like if it was pointed at a foreign handle before this fix.
  const tamper = async (id: string) => store.updateResourceAttachment(id, { credentialHandles: [PLATFORM_HANDLE] });
  const environment = async () => {
    const task = await store.createTask({ projectId: project.id, title: 'Consumer', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'work' } });
    world = await worlds.create('memory', { taskId: task.id, base: 'main' });
    world.handle = await resources.materialize(project.id, task.id, world, 1);
    world.handle = (await store.registerWorld(world.handle, project.id)) as typeof world.handle;
    return resources.environmentFor((await resources.prepare(world)).handle);
  };
  const platformIntact = async () => expect(await broker.resolve(PLATFORM_HANDLE, { caps: [`use-credential:${PLATFORM_HANDLE}`] }))
    .toBe(PLATFORM_SECRET);

  it('refuses a request that names the vault handles a resource uses', async () => {
    const id = await createSecret();
    const response = await patch(id, { credentialHandles: [PLATFORM_HANDLE] });
    expect(response.status).toBe(400);
    expect((await store.getResourceAttachment(id))!.credentialHandles).toEqual([`resource:${id}:credential`]);
    expect(await environment()).toEqual({ APP_TOKEN: 'own-value' });
  });

  it('keeps the vault provenance of a resource out of reach of a request', async () => {
    const id = await createSecret();
    expect((await patch(id, { source: { vaultItemId: 'item_foreign', vaultField: 'password', note: 'kept' } })).status)
      .toBe(200);
    const { source } = (await store.getResourceAttachment(id))!;
    expect(source.vaultItemId).toBeUndefined();
    expect(source.vaultField).toBeUndefined();
    expect(source.note).toBe('kept');
  });

  it('never projects a credential the resource does not own into a task', async () => {
    const id = await createSecret();
    await tamper(id);
    await expect(environment()).rejects.toThrow(/does not own/);
    await platformIntact();
  });

  it('writes a new secret to the resource\'s own handle, never the one it named', async () => {
    const id = await createSecret();
    await tamper(id);
    expect((await patch(id, { secret: 'replacement' })).status).toBe(200);
    await platformIntact();
    expect((await store.getResourceAttachment(id))!.credentialHandles).toEqual([`resource:${id}:credential`]);
    expect(await environment()).toEqual({ APP_TOKEN: 'replacement' });
  });

  it('imports a pasted value into the resource\'s own handle, never the one it named', async () => {
    const id = await createSecret();
    await tamper(id);
    const response = await fetch(`${server.url}/api/projects/${project.id}/secrets`, { method: 'POST', headers,
      body: JSON.stringify({ env: 'APP_TOKEN=pasted\n' }) });
    expect(response.status).toBe(200);
    await platformIntact();
    expect(await environment()).toEqual({ APP_TOKEN: 'pasted' });
  });

  it('deletes only the resource\'s own secret', async () => {
    const id = await createSecret();
    await tamper(id);
    expect((await fetch(`${server.url}/api/projects/${project.id}/resources/${id}`, { method: 'DELETE', headers })).status)
      .toBe(200);
    await platformIntact();
  });

  it('still projects a vault item of its own organization, and refuses one of another', async () => {
    const own = await new VaultItems(store, broker, dir, project.organizationId)
      .save({ type: 'login', label: 'Own login', secrets: { password: 'vault-password' }, provenance: { source: 'test' } });
    const other = await store.createOrganization({ name: 'Other tenant', ownerUserId: 'someone-else' });
    const foreign = await new VaultItems(store, broker, dir, other.id)
      .save({ type: 'login', label: 'Foreign login', secrets: { password: 'foreign-password' }, provenance: { source: 'test' } });
    const projection = (name: string, itemId: string) => store.createResourceAttachment({ organizationId: project.organizationId!,
      projectId: project.id, name, driver: 'secret@1', target: { kind: 'environment', name }, access: 'read', isolation: 'fork',
      source: { vaultItemId: itemId, vaultField: 'password' }, credentialHandles: [itemHandle(itemId, 'password')], publish: 'discard' });
    await projection('OWN_PASSWORD', own.id);
    expect(await environment()).toEqual({ OWN_PASSWORD: 'vault-password' });
    await world?.destroy(); world = undefined;
    await projection('FOREIGN_PASSWORD', foreign.id);
    await expect(environment()).rejects.toThrow(/does not own/);
  });
});
