import { roleCeiling } from '../src/contrib/manifests.js';
import { CAPABILITIES, allows } from '../src/platform/capabilities.js';
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Gateway } from '../src/gateway/server.js';
import { KarmaxApi } from '../src/platform/api.js';
import { DEFAULT_AUTHORIZATION_PROFILES } from '../src/platform/authorization.js';
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

describe('human and agent authorization-level parity', () => {
  it.each(DEFAULT_AUTHORIZATION_PROFILES)('$name has the same HTTP authority for both actors', async (profile) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-parity-'));
    const store = new Store(':memory:');
    store.claimPersonalOrganization('me');
    const project = store.createProject('Parity');
    const tokens = new TokenAuthority();
    const worlds = new WorldRegistry();
    const objects = new LocalObjectStore(path.join(dir, 'objects'));
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    const resources = new ProjectResourceService(store, worlds, new ObjectSnapshotEngine(objects, broker), broker);
    const client = { workflow: { getHandle: () => ({}) } } as any;
    const api = new KarmaxApi({ store, tokens, client, worlds, resources, broker, taskQueue: 'test' });
    const gateway = new Gateway({ api, store, tokens, client, worlds, resources, broker, objects,
      taskQueue: 'test', staticDir: 'web', bus: new KarmaxBus(), contributions: new ContributionRegistry(),
      overlays: new Overlays(), agentInfo: { provider: 'mock', reason: 'authorization parity test' } });
    const server = await gateway.listen(await findFreePortFrom(nextPort += 10));
    cleanups.push(async () => { await server.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

    // Use an actual gateway browser session, then give both actors exactly the
    // same canonical level and scope. Delegation supplies identity, not power.
    const session = await (await fetch(`${server.url}/api/session`)).json() as { token: string };
    const humanToken = (gateway as any).sessions.get(session.token).apiToken as string;
    const human = tokens.verify(humanToken)!;
    human.caps = [...profile.capabilities];
    human.organizationId = profile.id === 'god' ? undefined : project.organizationId;
    human.projectId = ['administrator', 'god'].includes(profile.id) ? undefined : project.id;
    const delegation = tokens.delegateHuman(humanToken, { taskId: 'parity-agent',
      projectId: human.projectId, organizationId: human.organizationId })!;
    const agent = tokens.mint({ taskId: 'parity-agent', principal: 'task:parity-agent', profileId: profile.id,
      projectId: human.projectId, organizationId: human.organizationId, delegationId: delegation.id,
      ceiling: roleCeiling('do'), grantorCaps: [...profile.capabilities] });
    for (const role of ['do', 'confirm', 'resolve', 'merge']) {
      const roleToken = tokens.mint({ taskId: `${role}-parity`, principal: `task:${role}-parity`,
        profileId: profile.id, role, projectId: human.projectId, organizationId: human.organizationId,
        ceiling: roleCeiling(role), grantorCaps: [...profile.capabilities] });
      for (const capability of [...CAPABILITIES, '*']) {
        expect(allows(roleToken.record.caps, capability), `${profile.id}/${role}: ${capability}`)
          .toBe(allows(human.caps, capability));
      }
    }
    const projectWrite = ['maintainer', 'administrator', 'god'].includes(profile.id);
    const orgAdmin = ['administrator', 'god'].includes(profile.id);
    const statuses: number[][] = [];
    for (const [kind, token] of [['human', session.token], ['agent', agent.token]] as const) {
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
      const call = async (method: string, route: string, body?: unknown) => fetch(`${server.url}${route}`, {
        method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const existing = store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
        name: `Existing ${kind}`, driver: 'volume@1', target: { kind: 'path', path: `existing-${kind}` },
        access: 'read', isolation: 'fork', publish: 'discard', source: {}, credentialHandles: [] });
      const checks: Array<[Response, number]> = [
        [await call('GET', `/api/projects/${project.id}/resources`), 200],
        [await call('POST', `/api/projects/${project.id}/resources`, { name: `Data ${kind}`,
          files: [{ path: 'data.txt', data: 'data', encoding: 'utf8' }] }), projectWrite ? 200 : 403],
        [await call('PATCH', `/api/projects/${project.id}/resources/${existing.id}`, { enabled: false }), projectWrite ? 200 : 403],
        [await call('DELETE', `/api/projects/${project.id}/resources/${existing.id}`), projectWrite ? 200 : 403],
        [await call('POST', `/api/projects/${project.id}/secrets`, { name: `KEY_${kind.toUpperCase()}`, value: 'test-key' }), projectWrite ? 200 : 403],
        [await call('GET', '/api/vault/items'), orgAdmin || profile.id === 'developer' || profile.id === 'maintainer' ? 200 : 403],
        [await call('DELETE', '/api/vault/items/nonexistent'), orgAdmin ? 200 : 403],
        [await call('GET', '/api/users'), profile.id === 'god' ? 200 : 403],
        [await call('POST', '/api/users', { name: 'New account' }), profile.id === 'god' ? 400 : 403],
        [await call('POST', `/api/projects/${project.id}/avatars`, { name: `Helper ${kind}`,
          prompt: 'Help with project work.', runtime: { provider: 'mock' } }), profile.id === 'viewer' ? 403 : 201],
        [await call('POST', `/api/projects/${project.id}/avatars`, { name: `Organization helper ${kind}`,
          prompt: 'Help across the organization.', runtime: { provider: 'mock' }, authorityMode: 'restricted',
          authorization: { level: profile.id, scope: 'organization' } }), orgAdmin ? 201 : 403],
        [await call('GET', '/api/user/default-organization'), 200],
        [await call('GET', `/api/inbox?organizationId=${project.organizationId}`), 200],
      ];
      for (const [response, expected] of checks) {
        expect(response.status, `${profile.id} ${kind}: ${response.url}: ${await response.text()}`).toBe(expected);
      }
      statuses.push(checks.map(([response]) => response.status));
    }
    expect(statuses[0]).toEqual(statuses[1]);
    if (profile.id === 'god') {
      const autonomous = tokens.mint({ taskId: 'autonomous-admin', principal: 'task:autonomous-admin',
        profileId: 'god', ceiling: ['*'], grantorCaps: ['*'] });
      const response = await fetch(`${server.url}/api/users`, {
        method: 'POST', headers: { authorization: `Bearer ${autonomous.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'New account' }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'identity service unavailable' });
    }

  });
});
