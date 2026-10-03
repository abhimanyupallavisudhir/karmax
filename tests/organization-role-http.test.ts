import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Gateway } from '../src/gateway/server.js';
import { KarmaxApi } from '../src/platform/api.js';
import { AuthorizationService, DEFAULT_AUTHORIZATION_PROFILES } from '../src/platform/authorization.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { Store } from '../src/store/db.js';
import { LocalObjectStore } from '../src/store/objects.js';
import { Overlays } from '../src/store/overlays.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { WorldRegistry } from '../src/world/registry.js';
import { ObjectSnapshotEngine, ProjectResourceService } from '../src/world/resources.js';
import { findFreePortFrom } from '../src/util/ports.js';

let nextPort = 49_900;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });


describe('organization role HTTP API', () => {
  it('enforces scope and delegation and returns persisted roles to the selector catalog', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-parity-'));
    const store = (await Store.create(':memory:'));
    (await store.claimPersonalOrganization('me'));
    const project = (await store.createProject('Parity'));
    (await store.kvSet(`avatars:project:${project.id}`, 'enabled'));
    const tokens = new TokenAuthority();
    const worlds = new WorldRegistry();
    const objects = new LocalObjectStore(path.join(dir, 'objects'));
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    const resources = new ProjectResourceService(store, worlds, new ObjectSnapshotEngine(objects, broker), broker);
    const client = { workflow: { getHandle: () => ({}) } } as any;
    const api = new KarmaxApi({ store, tokens, client, worlds, resources, broker, taskQueue: 'test' });
    const authorization = (await AuthorizationService.create(store));
    const gateway = (await Gateway.create({ authorization, api, store, tokens, client, worlds, resources, broker, objects,
      taskQueue: 'test', staticDir: 'web', bus: new KarmaxBus(), contributions: new ContributionRegistry(),
      overlays: new Overlays(), agentInfo: { provider: 'mock', reason: 'authorization parity test' } }));
    const server = await gateway.listen(await findFreePortFrom(nextPort += 10));
    cleanups.push(async () => { await server.close(); (await store.close()); fs.rmSync(dir, { recursive: true, force: true }); });


    const session = await (await fetch(`${server.url}/api/session`)).json() as { token: string };
    const humanToken = (gateway as any).sessions.get(session.token).apiToken as string;
    const principal = (await tokens.verify(humanToken))!;
    principal.organizationId = project.organizationId;
    principal.caps = [...DEFAULT_AUTHORIZATION_PROFILES.find((p) => p.id === 'administrator')!.capabilities];
    const request = (path: string, body?: unknown) => fetch(`${server.url}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${humanToken}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const url = `/api/organizations/${project.organizationId}/roles`;
    const response = await request(url);
    expect(response.status).toBe(200);
    const catalog = await response.json() as any;
    expect(catalog.profiles).toHaveLength(6);
    expect(catalog.canCreate).toBe(true);
    expect(catalog.creatableCapabilities).toContain('task:read');
    expect(catalog.creatableCapabilities).not.toContain('settings:write');
    const payload = { name: 'Task reader', description: 'Read tasks', capabilities: ['task:read'] };
    const created = await request(url, payload);
    expect(created.status).toBe(201);
    const role = await created.json() as any;
    expect((await (await request(url)).json() as any).profiles).toContainEqual(expect.objectContaining({ id: role.id }));
    expect((await request(url, payload)).status).toBe(400);
    expect((await request(url, { ...payload, name: 'Global', capabilities: ['settings:write'] })).status).toBe(403);
    expect((await request(url, { ...payload, capabilities: ['invented'] })).status).toBe(400);
    const foreign = (await store.createOrganization({ name: 'Foreign' }));
    expect((await request(`/api/organizations/${foreign.id}/roles`)).status).toBe(403);
    principal.caps = ['organization:read'];
    expect((await request(url, { ...payload, name: 'Denied' })).status).toBe(403);
    expect((await (await request(url)).json() as any).canCreate).toBe(false);
  });
});
