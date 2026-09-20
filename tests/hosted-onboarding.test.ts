import * as __asyncCollections from '../src/util/async-collections.js';
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IdentityService } from '../src/auth/identity.js';
import { AuthorizationService } from '../src/platform/authorization.js';
import { Gateway } from '../src/gateway/server.js';
import { hostedOnboardingStatus, parseHostedOnboardingRecord } from '../src/gateway/hosted-onboarding.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { findFreePortFrom } from '../src/util/ports.js';
import { WorldRegistry } from '../src/world/registry.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { Vault } from '../src/autonomy/vault.js';
import { WorldProviderConnectionService } from '../src/world/connections.js';
import { VaultItems } from '../src/autonomy/vault-items.js';

const closers: Array<() => Promise<void>> = [];
const tempDirs: string[] = [];
afterAll(async () => {
  for (const close of closers) await close().catch(() => {});
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

async function boot(hosted: boolean) {
  const port = await findFreePortFrom(48260);
  const identity = await IdentityService.open(':memory:', { baseURL: `http://127.0.0.1:${port}` });
  const store = (await Store.create(':memory:'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-onboarding-'));
  tempDirs.push(dir);
  const broker = new CredentialBroker(new Vault(dir));
  const providers = new WorldProviderConnectionService(store, broker);
  const gateway = (await Gateway.create({
    api: {} as any,
    store,
    bus: new KarmaxBus(),
    tokens: new TokenAuthority(),
    contributions: new ContributionRegistry(),
    overlays: new Overlays(),
    client: {} as any,
    taskQueue: 'test',
    staticDir: process.cwd(),
    agentInfo: { provider: 'mock', reason: 'hosted onboarding test' },
    identity,
    authorization: (await AuthorizationService.create(store)),
    worlds: new WorldRegistry(),
    broker,
    providerConnections: providers,
    hosted,
  }));
  const running = await gateway.listen(port);
  closers.push(() => running.close());
  const setup = await fetch(`${running.url}/api/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Alice', email: 'alice@example.com', password: 'long-enough-password' }),
  });
  expect(setup.status).toBe(200);
  const cookie = setup.headers.get('set-cookie')?.match(/better-auth\.session_token=[^;]+/)?.[0] ?? '';
  const onboarding = (organizationId: string, method = 'GET', body?: object) => fetch(
    `${running.url}/api/user/onboarding?organizationId=${encodeURIComponent(organizationId)}`, {
      method, headers: { cookie, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
  const request = (method = 'GET', body?: object) => onboarding('org_personal', method, body);
  return { store, identity, broker, providers, request, onboarding, base: running.url, cookie };
}

describe('hosted onboarding status API', () => {
  it('persists display state, derives required steps from live state, and makes completion sticky', async () => {
    const { store, broker, providers, request } = await boot(true);
    const initial = await (await request()).json() as any;
    expect(initial).toMatchObject({ eligible: true, visible: true, complete: false,
      display: 'expanded', completedRequired: 0, totalRequired: 4 });
    expect(initial.steps.optional).toMatchObject({ blocking: false, complete: false, vault: false, card: false });

    const minimized = await (await request('PUT', { display: 'minimized' })).json() as any;
    expect(minimized.display).toBe('minimized');
    expect((await (await request()).json() as any).display).toBe('minimized');

    (await store.upsertGitConnection({ organizationId: 'org_personal', provider: 'github',
      installationId: 'installation-1', accountLogin: 'alice', accountType: 'User' }));
    broker.registerHandle('openai:first', 'sk-test');
    (await providers.save({ organizationId: 'org_personal', provider: 'e2b', apiKey: 'e2b-test' }));
    (await store.createProject('First project', {}, 'org_personal'));

    const completed = await (await request()).json() as any;
    expect(completed).toMatchObject({ visible: false, complete: true, completedRequired: 4 });
    // Optional passwords/cards remain honestly incomplete, but never hold back
    // overall onboarding completion.
    expect(completed.steps.optional).toMatchObject({ complete: false, blocking: false });

    (await providers.delete('org_personal', 'e2b'));
    const afterDisconnect = await (await request()).json() as any;
    expect(afterDisconnect).toMatchObject({ visible: false, complete: true });
    expect(afterDisconnect.steps.e2b.complete).toBe(false);

    (await new VaultItems(store, broker, undefined, 'org_personal').save({
      type: 'login', label: 'Example login', secrets: { password: 'secret' },
    }));
    (await store.createCard({ id: 'card-1', provider: 'vault', scope: 'organization', scopeId: 'org_personal',
      label: 'Workspace card', cap: 10_000, available: 10_000, createdAt: Date.now() }));
    const withOptional = await (await request()).json() as any;
    expect(withOptional.steps.optional).toMatchObject({ complete: true, blocking: false, vault: true, card: true });
  });

  it('recovers missing enrollment and retains unfinished progress across logout and login', async () => {
    const { store, identity, request, base, cookie } = await boot(true);
    const userId = (await identity.listUsers())[0]!.id;
    const key = `hosted:onboarding:${userId}:org_personal`;
    (await store.kvDelete(key));
    expect(await (await request()).json()).toMatchObject({ visible: true, complete: false, display: 'expanded' });
    (await store.upsertGitConnection({ organizationId: 'org_personal', provider: 'github',
      installationId: 'persist-installation', accountLogin: 'alice', accountType: 'User' }));
    await request('PUT', { display: 'minimized' });
    const logout = await fetch(`${base}/api/logout`, { method: 'POST', headers: { cookie } });
    expect(logout.status).toBe(200);
    expect((await request()).status).toBe(401);
    const login = await fetch(`${base}/api/auth/sign-in/email`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ email: 'alice@example.com', password: 'long-enough-password' }),
    });
    expect(login.status).toBe(200);
    const nextCookie = login.headers.get('set-cookie')?.match(/better-auth\.session_token=[^;]+/)?.[0] ?? '';
    expect(nextCookie).not.toBe('');
    const status = await fetch(`${base}/api/user/onboarding?organizationId=org_personal`, { headers: { cookie: nextCookie } });
    expect(await status.json()).toMatchObject({ visible: true, complete: false, display: 'minimized', completedRequired: 1 });
  });

  it('lets ordinary users restart only their own guide, without closing an incomplete replay', async () => {
    const { identity, base, store } = await boot(true);
    const operator = (await identity.listUsers())[0]!.id;
    const bob = await identity.createUser({ name: 'Bob', email: 'bob@example.com', password: 'long-enough-password' });
    const login = await fetch(`${base}/api/auth/sign-in/email`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ email: 'bob@example.com', password: 'long-enough-password' }),
    });
    const cookie = login.headers.get('set-cookie')?.match(/better-auth\.session_token=[^;]+/)?.[0] ?? '';
    expect(cookie).not.toBe('');
    // A real session provisions the ordinary user's personal organization.
    expect((await fetch(`${base}/api/session`, { headers: { cookie } })).status).toBe(200);
    const organization = (await store.listOrganizations(bob.id))[0]!;
    const key = `hosted:onboarding:${bob.id}:${organization.id}`;
    (await store.kvSet(key, JSON.stringify({ display: 'minimized', completedAt: 123 })));
    const operatorKey = `hosted:onboarding:${operator}:org_personal`;
    const before = (await store.kvGet(operatorKey));
    const reset = await fetch(`${base}/api/user/onboarding/reset`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ userId: operator }),
    });
    expect(reset.status).toBe(200);
    expect((await store.kvGet(operatorKey))).toBe(before);
    const endpoint = `${base}/api/user/onboarding?organizationId=${organization.id}`;
    expect(await (await fetch(endpoint, { headers: { cookie } })).json())
      .toMatchObject({ visible: true, complete: false, display: 'expanded', replay: true });
    expect(await (await fetch(endpoint, { method: 'PUT', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ finishReplay: true }) })).json())
      .toMatchObject({ visible: true, complete: false, replay: true });
    expect((await fetch(`${base}/api/user/onboarding?organizationId=org_personal`, { headers: { cookie } })).status).toBe(404);
    expect((await fetch(`${base}/api/user/onboarding/reset`, { method: 'POST' })).status).toBe(401);
  });

  it('lets an operator replay a completed user’s guide without changing their work', async () => {
    const { store, identity, broker, providers, request, base, cookie } = await boot(true);
    const userId = (await identity.listUsers())[0]!.id;
    (await store.upsertGitConnection({ organizationId: 'org_personal', provider: 'github',
      installationId: 'keep-installation', accountLogin: 'alice', accountType: 'User' }));
    broker.registerHandle('openai:first', 'sk-test');
    (await providers.save({ organizationId: 'org_personal', provider: 'e2b', apiKey: 'e2b-test' }));
    const project = (await store.createProject('Keep my work', {}, 'org_personal'));
    expect(await (await request()).json()).toMatchObject({ complete: true, visible: false });
    const reset = (id: string) => fetch(`${base}/api/users/${id}/onboarding/reset`, {
      method: 'POST', headers: { cookie },
    });
    const other = await identity.createUser({ name: 'Other', email: 'other@example.com', password: 'long-enough-password' });
    const untouchedKey = `hosted:onboarding:${other.id}:org_personal`;
    (await store.kvSet(untouchedKey, JSON.stringify({ display: 'minimized', completedAt: 123 })));
    expect((await reset('missing')).status).toBe(404);
    expect((await reset(userId)).status).toBe(200);
    for (let i = 0; i < 2; i++)
      expect(await (await request()).json()).toMatchObject({ complete: false, visible: true,
        replay: true, display: 'expanded', completedRequired: 4 });
    expect((await store.kvGet(untouchedKey))).toBe(JSON.stringify({ display: 'minimized', completedAt: 123 }));
    expect((await store.listProjects())).toContainEqual(project);
    expect((await store.listGitConnections('org_personal'))[0]!.installationId).toBe('keep-installation');
    expect(await (await request('PUT', { display: 'minimized' })).json())
      .toMatchObject({ replay: true, visible: true, display: 'minimized' });
    expect(await (await request('PUT', { finishReplay: true })).json())
      .toMatchObject({ replay: false, complete: true, visible: false });
  });

  it('refuses walkthrough resets from an ordinary account', async () => {
    const { identity, base, store } = await boot(true);
    const target = (await identity.listUsers())[0]!.id;
    await identity.createUser({ name: 'Bob', email: 'bob@example.com', password: 'long-enough-password' });
    const login = await fetch(`${base}/api/auth/sign-in/email`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ email: 'bob@example.com', password: 'long-enough-password' }),
    });
    expect(login.status).toBe(200);
    const bobCookie = login.headers.get('set-cookie')?.match(/better-auth\.session_token=[^;]+/)?.[0] ?? '';
    expect(bobCookie).not.toBe('');
    const key = `hosted:onboarding:${target}:org_personal`;
    const before = (await store.kvGet(key));
    const denied = await fetch(`${base}/api/users/${target}/onboarding/reset`, {
      method: 'POST', headers: { cookie: bobCookie },
    });
    expect(denied.status).toBe(403);
    expect((await store.kvGet(key))).toBe(before);
  });

  it('never enrolls a self-hosted account into the hosted walkthrough', async () => {
    const { onboarding, base, cookie } = await boot(false);
    const created = await fetch(`${base}/api/organizations`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Self-hosted team' }),
    });
    expect(created.status).toBe(200);
    const organization = await created.json() as any;
    const status = await (await onboarding(organization.id)).json() as any;
    expect(status).toMatchObject({ organizationId: organization.id, eligible: false, visible: false, complete: false });
  });

  it('enrolls the owner when a signed-in user creates a hosted organization', async () => {
    const { onboarding, base, cookie } = await boot(true);
    const created = await fetch(`${base}/api/organizations`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'New hosted team' }),
    });
    expect(created.status).toBe(200);
    const organization = await created.json() as any;
    const status = await (await onboarding(organization.id)).json() as any;
    expect(status).toMatchObject({
      organizationId: organization.id,
      eligible: true,
      visible: true,
      complete: false,
      completedRequired: 0,
    });
  });

  it('does not count an unrelated vault item as an optional password', async () => {
    const { store, broker, request } = await boot(true);
    (await new VaultItems(store, broker, undefined, 'org_personal').save({
      type: 'note', label: 'Deployment notes', secrets: { note: 'not a password' },
    }));
    const status = await (await request()).json() as any;
    expect(status.steps.optional).toMatchObject({ vault: false, complete: false, blocking: false });
  });
});

describe('hosted onboarding completion semantics', () => {
  it('retains incomplete, completed, and replay records across a database restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-onboarding-restart-'));
    tempDirs.push(dir);
    const database = path.join(dir, 'store.db');
    const records = [
      { display: 'expanded' }, { display: 'minimized' },
      { display: 'expanded', completedAt: 123 }, { display: 'expanded', replay: true },
    ];
    const first = (await Store.create(database));
    (await __asyncCollections.forEach(records, async (record, i) => (await first.kvSet(`hosted:onboarding:user${i}:org1`, JSON.stringify(record)))));
    (await first.close());
    const reopened = (await Store.create(database));
    try {
      (await __asyncCollections.forEach(records, async (record, i) => {
        const saved = parseHostedOnboardingRecord((await reopened.kvGet(`hosted:onboarding:user${i}:org1`)));
        expect(saved).toEqual(record);
        expect(hostedOnboardingStatus({ hosted: true, organizationId: 'org1', record: saved,
          facts: { github: true, agentLogin: false, e2b: false, vault: false, card: false, project: true },
        }).visible).toBe(i !== 2);
      }));
    } finally { (await reopened.close()); }
  });

  it('does not count the optional password/card item toward the required total', () => {
    const status = hostedOnboardingStatus({
      hosted: true,
      organizationId: 'org_1',
      record: { display: 'expanded' },
      facts: { github: true, agentLogin: true, e2b: true, vault: false, card: false, project: true },
    });
    expect(status).toMatchObject({ complete: true, completedRequired: 4, totalRequired: 4 });
    expect(status.steps.optional).toMatchObject({ complete: false, blocking: false });
  });

  it('requires an enrollment record (the hosted API repairs missing records)', () => {
    const status = hostedOnboardingStatus({
      hosted: true,
      organizationId: 'org_established',
      facts: { github: false, agentLogin: false, e2b: false, vault: false, card: false, project: true },
    });
    expect(status).toMatchObject({ eligible: false, visible: false });
  });
});
