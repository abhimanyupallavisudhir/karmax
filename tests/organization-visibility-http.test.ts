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


describe('organization name visibility HTTP API', () => {
  it('restricts visibility changes and exposes only public names while preserving resource permissions', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-parity-'));
    const store = new Store(':memory:');
    store.claimPersonalOrganization('me');
    const project = store.createProject('Parity');
    store.kvSet(`avatars:project:${project.id}`, 'enabled');
    const tokens = new TokenAuthority();
    const worlds = new WorldRegistry();
    const objects = new LocalObjectStore(path.join(dir, 'objects'));
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    const resources = new ProjectResourceService(store, worlds, new ObjectSnapshotEngine(objects, broker), broker);
    const client = { workflow: { getHandle: () => ({}) } } as any;
    const api = new KarmaxApi({ store, tokens, client, worlds, resources, broker, taskQueue: 'test' });
    const authorization = new AuthorizationService(store);
    const gateway = new Gateway({ authorization, api, store, tokens, client, worlds, resources, broker, objects,
      taskQueue: 'test', staticDir: 'web', bus: new KarmaxBus(), contributions: new ContributionRegistry(),
      overlays: new Overlays(), agentInfo: { provider: 'mock', reason: 'authorization parity test' } });
    const server = await gateway.listen(await findFreePortFrom(nextPort += 10));
    cleanups.push(async () => { await server.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });


    const session = await (await fetch(`${server.url}/api/session`)).json() as { token: string };
    const humanToken = (gateway as any).sessions.get(session.token).apiToken as string;
    const principal = tokens.verify(humanToken)!;
    principal.organizationId = project.organizationId;
    const call = (method: string, route: string, body?: unknown) => fetch(`${server.url}${route}`, {
      method, headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const foreign = store.createOrganization({ name: 'Hidden team', ownerUserId: 'someone-else' });
    const ownUrl = `/api/organizations/${project.organizationId}`;
    const foreignUrl = `/api/organizations/${foreign.id}`;
    principal.caps = [...DEFAULT_AUTHORIZATION_PROFILES.find((p) => p.id === 'administrator')!.capabilities];
    expect((await call('PATCH', ownUrl, { nameVisibility: 'public' })).status).toBe(200);
    expect(store.getOrganization(project.organizationId!)?.nameVisibility).toBe('public');
    expect((await call('PATCH', ownUrl, { nameVisibility: 'invalid', name: 'Must not rename' })).status).toBe(400);
    expect(store.getOrganization(project.organizationId!)?.name).not.toBe('Must not rename');
    expect((await call('PATCH', foreignUrl, { nameVisibility: 'public' })).status).toBe(403);
    principal.caps = ['organization:read'];
    expect((await call('PATCH', ownUrl, { nameVisibility: 'members' })).status).toBe(403);
    const directory = async () => {
      const response = await call('GET', '/api/organization-directory');
      const body = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(200);
      return body as any[];
    };
    expect((await directory()).map((o) => o.id)).not.toContain(foreign.id);
    store.setOrganizationNameVisibility(foreign.id, 'public');
    expect(await directory()).toContainEqual({ id: foreign.id, name: foreign.name, accessible: false });
    expect((await call('GET', foreignUrl)).status).toBe(403);
    expect((await call('PUT', '/api/user/default-organization', { organizationId: foreign.id })).status).toBe(400);
    expect((await (await call('GET', '/api/organizations')).json() as any[]).map((o) => o.id)).not.toContain(foreign.id);
    store.setOrganizationNameVisibility(foreign.id, 'members');
    expect((await directory()).map((o) => o.id)).not.toContain(foreign.id);
    principal.caps = ['*'];
    principal.organizationId = undefined;
    expect(await directory()).toContainEqual({ id: foreign.id, name: foreign.name, accessible: true });
    expect((await call('PUT', '/api/user/default-organization', { organizationId: foreign.id })).status).toBe(200);
    expect(await (await call('GET', '/api/user/default-organization')).json()).toEqual({ organizationId: foreign.id });
  });
});
