// tavya.error 52b0c54c03109cb1 (2026-11-28): a CEO agent asked create_task for
// {level: "administrator", scope: "projects"}. Administrator is an organization
// level, so the request was rightly refused — but with a bare Error, which the
// gateway answers as an unexpected 500 and files as a bug of tavya's. Every
// refusal of an authorization selection or profile a caller supplied is the
// caller's to fix: typed, 4xx, with its message.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Gateway } from '../src/gateway/server.js';
import { KarmaxApi } from '../src/platform/api.js';
import { AuthorizationService, DEFAULT_AUTHORIZATION_PROFILES, organizationScope } from '../src/platform/authorization.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { Store } from '../src/store/db.js';
import { Overlays } from '../src/store/overlays.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { WorldRegistry } from '../src/world/registry.js';
import { findFreePortFrom } from '../src/util/ports.js';
import { errorStatus } from '../src/gateway/error-status.js';

const caps = (id: string) => DEFAULT_AUTHORIZATION_PROFILES.find((profile) => profile.id === id)!.capabilities;

const refusal = async (call: Promise<unknown>) => {
  const error = await call.then(() => undefined, (e: unknown) => e);
  expect(error, 'the call should have been refused').toBeInstanceOf(Error);
  return { status: errorStatus(error, 500), message: (error as Error).message };
};

let nextPort = 51_700;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe('authorization selection refusals', () => {
  it('answers every malformed selection or profile with a 4xx and its reason', async () => {
    const store = await Store.create(':memory:');
    try {
      const authz = await AuthorizationService.create(store);
      const organization = await store.createOrganization({ name: 'Acme' });
      const project = await store.createProject('P', {}, organization.id);
      const other = await store.createOrganization({ name: 'Other' });
      const foreign = await store.createProject('Q', {}, other.id);
      await authz.grant('test', { principalId: 'user:owner', scopeKey: organizationScope(organization.id), profileId: 'superadmin' });
      const grant = (selection: any) => authz.taskGrant('user:owner', project.id, selection);

      // Each selection names a level the scope cannot carry, or no scope at all.
      expect(await refusal(grant({ level: 'administrator', scope: 'projects', projectIds: [project.id] })))
        .toEqual({ status: 400, message: 'Administrator requires organization scope' });
      expect(await refusal(grant({ level: 'superadmin', scope: 'projects', projectIds: [project.id] })))
        .toEqual({ status: 400, message: 'Super-administrator requires organization scope' });
      expect(await refusal(grant({ level: 'god', scope: 'organization' }))).toEqual({ status: 400, message: 'God requires global scope' });
      expect(await refusal(grant({ level: 'developer', scope: 'global' })))
        .toEqual({ status: 400, message: 'developer requires project or organization scope' });
      expect(await refusal(grant({ level: 'developer', scope: 'projects', projectIds: [] })))
        .toEqual({ status: 400, message: 'choose at least one project or @organization' });
      expect(await refusal(grant({ level: 'developer', scope: 'projects', projectIds: [foreign.id] })))
        .toEqual({ status: 400, message: 'authorization projects must belong to the same organization' });
      expect(await refusal(grant({ level: 'nonesuch', scope: 'organization' })))
        .toEqual({ status: 400, message: 'unknown authorization level nonesuch' });
      expect(await refusal(authz.taskGrant('user:owner', 'proj_missing', { level: 'developer', scope: 'organization' })))
        .toMatchObject({ status: 404 });
      // The same rules reached through every other entry point.
      expect(await refusal(authz.requestedCapabilities(project.id, { level: 'administrator', scope: 'projects', projectIds: [project.id] })))
        .toMatchObject({ status: 400 });
      expect(await refusal(authz.replacePrincipalAuthorization('user:owner', 'user:dev', organization.id,
        { level: 'administrator', scope: 'projects', projectIds: [project.id] }))).toMatchObject({ status: 400 });
      expect(await refusal(authz.assertCanGrantSelection('user:owner', other.id, { level: 'developer', scope: 'projects', projectIds: [project.id] })))
        .toEqual({ status: 400, message: 'authorization projects must belong to the same organization' });
      const empty = await store.createOrganization({ name: 'Empty' });
      expect(await refusal(authz.assertCanGrantSelection('user:owner', empty.id, { level: 'developer', scope: 'projects', projectIds: [project.id] })))
        .toMatchObject({ status: 400 });

      // Profiles, roles, defaults and grants.
      expect(await refusal(authz.setDefault('user:owner', 'operator'))).toMatchObject({ status: 400 });
      expect(await refusal(authz.saveProfile('user:owner', 'global', { id: ' ', name: 'x', capabilities: ['task:read'] } as any)))
        .toMatchObject({ status: 400 });
      expect(await refusal(authz.saveProfile('user:owner', 'global', { id: 'x', name: 'x', capabilities: [] } as any)))
        .toMatchObject({ status: 400 });
      expect(await refusal(authz.saveProfile('user:owner', 'global', { id: 'x', name: 'x', capabilities: ['made:up'] } as any)))
        .toMatchObject({ status: 400, message: 'unknown capability made:up' });
      expect(await refusal(authz.createOrganizationRole('user:owner', organization.id, { name: '' } as any, ['*'])))
        .toMatchObject({ status: 400 });
      const role = { name: 'Reviewer', description: 'Reads tasks', capabilities: ['task:read'] } as any;
      await authz.createOrganizationRole('user:owner', organization.id, role, ['*']);
      expect(await refusal(authz.createOrganizationRole('user:owner', organization.id, role, ['*'])))
        .toMatchObject({ status: 409, message: 'A role with this name already exists' });
      expect(await refusal(authz.deleteProfile('user:owner', 'global', 'developer'))).toMatchObject({ status: 400 });
      expect(await refusal(authz.grant('user:owner', { principalId: 'user:x', scopeKey: organizationScope(organization.id), profileId: 'nonesuch' })))
        .toMatchObject({ status: 400 });
      expect(await refusal(authz.grant('user:owner', { principalId: 'user:x', scopeKey: organizationScope(organization.id), profileId: 'viewer',
        capabilities: ['task:create'] }))).toMatchObject({ status: 400 });
    } finally { await store.close(); }
  });

  it('answers create_task with an organization level on a project scope with a 400, not a 500', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-authz-selection-'));
    const store = await Store.create(':memory:');
    const organization = await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
    const project = await store.createProject('Website', {}, organization.id);
    const tokens = new TokenAuthority(store);
    const worlds = new WorldRegistry();
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    const client = { workflow: { getHandle: () => ({}) } } as any;
    const authorization = await AuthorizationService.create(store);
    const api = new KarmaxApi({ store, tokens, client, worlds, broker, authorization, taskQueue: 'test' } as any);
    const gateway = await Gateway.create({ authorization, api, store, tokens, client, worlds, broker,
      taskQueue: 'test', staticDir: 'web', bus: new KarmaxBus(), contributions: new ContributionRegistry(),
      overlays: new Overlays(), agentInfo: { provider: 'mock', reason: 'authorization selection test' } } as any);
    const server = await gateway.listen(await findFreePortFrom(nextPort += 10));
    cleanups.push(async () => { await server.close(); await store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

    // The production caller: a superadmin CEO agent acting for the owner.
    const ceo = await store.createTask({ projectId: project.id, title: 'CEO', workflow: 'just-do', workflowVersion: '1', params: { prompt: '' } });
    const { token } = await tokens.mint({ taskId: ceo.id, projectId: project.id, organizationId: organization.id, principal: 'user:owner',
      profileId: 'superadmin', ceiling: ['*'], grantorCaps: caps('superadmin') });
    const response = await fetch(`${server.url}/api/projects/${project.id}/tasks`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Investigate', prompt: 'Look into it', holdForAuthorization: true,
        authorization: { level: 'administrator', scope: 'projects', projectIds: [project.id] } }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'Administrator requires organization scope' });
    // A workflow name it cannot start is the caller's to fix too.
    const unknown = await fetch(`${server.url}/api/projects/${project.id}/tasks`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Investigate', prompt: 'Look into it', workflow: 'nonesuch' }),
    });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: 'unknown workflow "nonesuch"' });
    // Nothing was created.
    expect((await store.listTasks(project.id)).map((task) => task.id)).toEqual([ceo.id]);
  });
});
