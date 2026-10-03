import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Gateway } from '../src/gateway/server.js';
import { KarmaxApi } from '../src/platform/api.js';
import { AuthorizationService, organizationScope } from '../src/platform/authorization.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { Store } from '../src/store/db.js';
import { Overlays } from '../src/store/overlays.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { WorldRegistry } from '../src/world/registry.js';
import { findFreePortFrom } from '../src/util/ports.js';

let nextPort = 51_700;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** A gateway whose browser session belongs to `userId`, so every request is
 * authorized the way tavya.io authorizes a signed-in person: per scope. */
async function signedIn(userId: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-escalation-scope-'));
  const store = await Store.create(':memory:');
  const organization = await store.createOrganization({ name: 'Mal\'ta parivar', ownerUserId: 'owner' });
  const project = await store.createProject('Website', {}, organization.id);
  const tokens = new TokenAuthority(store);
  const worlds = new WorldRegistry();
  const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
  const client = { workflow: { getHandle: () => ({}) } } as any;
  const authorization = await AuthorizationService.create(store);
  const api = new KarmaxApi({ store, tokens, client, worlds, broker, authorization, taskQueue: 'test' } as any);
  const identity = {
    connectOrganizationNames() {}, connectAccountClosure() {},
    listUsers: async () => [{ id: userId, name: 'Person', email: 'person@example.com' }],
    session: async () => ({ user: { id: userId, name: 'Person', email: 'person@example.com' },
      session: { id: `session-${userId}`, expiresAt: new Date(Date.now() + 60_000) } }),
    sessionActive: async () => true,
  };
  const gateway = await Gateway.create({ authorization, api, store, tokens, client, worlds, broker, identity,
    taskQueue: 'test', staticDir: 'web', bus: new KarmaxBus(), contributions: new ContributionRegistry(),
    overlays: new Overlays(), agentInfo: { provider: 'mock', reason: 'escalation scope test' } } as any);
  const server = await gateway.listen(await findFreePortFrom(nextPort += 10));
  cleanups.push(async () => { await server.close(); await store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const post = (route: string, body: unknown) => fetch(`${server.url}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { store, authorization, organization, project, post };
}

describe('asking for more authorization than you have', () => {
  it('lets an organization owner choosing God find out who can grant it', async () => {
    // tavya.io, 2026-10-02: the owner of a personal organization picked God in
    // the task form and was told only "missing capability task:create".
    const { authorization, organization, project, post } = await signedIn('owner');
    await authorization.bootstrapOrganizationOwner('system:test', 'owner', organization.id);
    const god = { level: 'god', scope: 'global' };

    const targets = await post(`/api/authorization/escalation-targets?projectId=${project.id}`, { projectId: project.id, authorization: god });
    expect(targets.status, await targets.clone().text()).toBe(200);
    const body = await targets.json() as any;
    expect(body.missingCapabilities).toEqual(['*']);
    expect(body.users).toEqual([]);

    // Naming the project only in the body cannot scope the session, so the
    // refusal says so instead of pretending the person lacks task:create.
    const unscoped = await post('/api/authorization/escalation-targets', { projectId: project.id, authorization: god });
    expect(unscoped.status).toBe(403);
    expect((await unscoped.json() as any).error)
      .toContain('missing capability task:create across the installation (the request names no project or organization)');

    const mismatched = await post(`/api/authorization/escalation-targets?projectId=${project.id}`, { projectId: 'proj_other', authorization: god });
    expect(mismatched.status).toBe(400);
    expect((await mismatched.json() as any).error).toMatch(/\?projectId=/);
  });

  it('tells a person what authorization they have where they were refused, and who has what they lack', async () => {
    const { authorization, organization, project, post } = await signedIn('viewer');
    await authorization.grant('test', { principalId: 'user:viewer', scopeKey: organizationScope(organization.id), profileId: 'viewer' });
    const refused = await post(`/api/projects/${project.id}/tasks`, { workflow: 'just-do', params: { prompt: 'hi' } });
    expect(refused.status).toBe(403);
    expect((await refused.json() as any).error).toBe(
      `missing capability task:create in project "Website" (${project.id}) of organization "Mal'ta parivar" (${organization.id}). `
      + 'Your authorization there is Viewer; Developer and above have it.');
  });
});
