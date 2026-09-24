import { expect, it } from 'vitest';
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
import { Overlays } from '../src/store/overlays.js';
import { findFreePortFrom } from '../src/util/ports.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { Vault } from '../src/autonomy/vault.js';
import { PaidLaunchSettingsService } from '../src/launch/settings.js';

it('exports only the authenticated user and records a deletion request without pretending to erase data', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-data-controls-'));
  const store = await Store.create(':memory:');
  const worlds = new WorldRegistry(), tokens = new TokenAuthority();
  const client = { workflow: { getHandle: () => ({ query: async () => [] }) } } as any;
  const api = new KarmaxApi({ store, tokens, worlds, client, taskQueue: 'test', contentDir: directory });
  const settings = new PaidLaunchSettingsService(store,
    new CredentialBroker(new Vault(path.join(directory, 'vault'))), {});
  await settings.configure({ contacts: { privacy: 'privacy@example.test' } }, 'http://localhost');
  const messages: Array<{ to: string; text: string }> = [];
  // Stub only the identity provider; exercise the real HTTP authorization and export routes.
  const profile = { id: 'me', name: 'Fixture user', email: 'me@example.test' };
  const gateway = await Gateway.create({ store, tokens, worlds, client, api,
    identity: { connectOrganizationNames: () => {},
      session: async (headers: Headers) => headers.get('cookie') === 'fixture=me'
        ? { user: profile, session: { id: 'fixture-session' } } : null,
      listUsers: async () => [profile],
      exportUserData: async () => ({ profile, authentication: {} }),
    } as any,
    authorization: await AuthorizationService.create(store), paidLaunchSettings: settings,
    email: { configured: async () => true, send: async (message: any) => { messages.push(message); } } as any,
    taskQueue: 'test', staticDir: path.resolve('web'), bus: new KarmaxBus(),
    contributions: new ContributionRegistry(), overlays: new Overlays(),
    agentInfo: { provider: 'mock', reason: 'isolated data-controls verification' } });
  const server = await gateway.listen(await findFreePortFrom(48980));
  try {
    const headers = { cookie: 'fixture=me', 'content-type': 'application/json' };
    expect((await fetch(`${server.url}/api/user/export`)).status).toBe(401);
    expect((await fetch(`${server.url}/api/user/account-deletion-request`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })).status).toBe(401);
    const project = await store.createProject('Export fixture', {}, 'org_personal');
    await store.setOrganizationMembership('org_personal', 'me', 'owner');
    await store.setOrganizationMembership('org_personal', 'bob', 'member');
    await store.createTask({ projectId: project.id, title: 'Own task', workflow: 'just-do', workflowVersion: '1',
      params: { prompt: 'own-data-fixture' }, createdBy: { kind: 'user', userId: 'me' } });
    await store.createTask({ projectId: project.id, title: 'Other task', workflow: 'just-do', workflowVersion: '1',
      params: { prompt: 'other-user-data-must-not-leak' }, createdBy: { kind: 'user', userId: 'bob' } });
    const exported = await fetch(`${server.url}/api/user/export?userId=bob`, { headers });
    expect(exported.status).toBe(200);
    const archive = await exported.text();
    expect(archive).toContain('own-data-fixture');
    expect(archive).not.toContain('other-user-data-must-not-leak');

    const response = await fetch(`${server.url}/api/user/account-deletion-request`, {
      method: 'POST', headers, body: JSON.stringify({ userId: 'bob', email: 'forged@example.test' }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ userId: 'me', privacyContact: 'privacy@example.test',
      next: expect.stringContaining('before irreversible deletion') });
    expect(JSON.parse((await store.kvGet('account-deletion:me'))!)).toMatchObject({ userId: 'me' });
    expect(await store.kvGet('account-deletion:bob')).toBeUndefined();
    expect(await store.getProject(project.id)).toBeDefined();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ to: 'privacy@example.test', text: expect.stringContaining('User id: me') });
    expect(messages[0]!.text).not.toContain('forged@example.test');
  } finally {
    await server.close();
    await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
