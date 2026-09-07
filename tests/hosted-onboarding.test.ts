import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IdentityService } from '../src/auth/identity.js';
import { AuthorizationService } from '../src/platform/authorization.js';
import { Gateway } from '../src/gateway/server.js';
import { hostedOnboardingStatus } from '../src/gateway/hosted-onboarding.js';
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
  const store = new Store(':memory:');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-onboarding-'));
  tempDirs.push(dir);
  const broker = new CredentialBroker(new Vault(dir));
  const providers = new WorldProviderConnectionService(store, broker);
  const tokens = new TokenAuthority();
  const gateway = new Gateway({
    api: {} as any,
    store,
    bus: new KarmaxBus(),
    tokens,
    contributions: new ContributionRegistry(),
    overlays: new Overlays(),
    client: {} as any,
    taskQueue: 'test',
    staticDir: process.cwd(),
    agentInfo: { provider: 'mock', reason: 'hosted onboarding test' },
    identity,
    authorization: new AuthorizationService(store),
    worlds: new WorldRegistry(),
    broker,
    providerConnections: providers,
    hosted,
  });
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
  const reset = (headers: Record<string, string> = { cookie }) => fetch(
    `${running.url}/api/settings/installation/onboarding/reset`, { method: 'POST', headers });
  return { store, broker, providers, tokens, request, onboarding, reset, base: running.url, cookie };
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

    store.upsertGitConnection({ organizationId: 'org_personal', provider: 'github',
      installationId: 'installation-1', accountLogin: 'alice', accountType: 'User' });
    broker.registerHandle('openai:first', 'sk-test');
    providers.save({ organizationId: 'org_personal', provider: 'e2b', apiKey: 'e2b-test' });
    store.createProject('First project', {}, 'org_personal');

    const completed = await (await request()).json() as any;
    expect(completed).toMatchObject({ visible: false, complete: true, completedRequired: 4 });
    // Optional passwords/cards remain honestly incomplete, but never hold back
    // overall onboarding completion.
    expect(completed.steps.optional).toMatchObject({ complete: false, blocking: false });

    providers.delete('org_personal', 'e2b');
    const afterDisconnect = await (await request()).json() as any;
    expect(afterDisconnect).toMatchObject({ visible: false, complete: true });
    expect(afterDisconnect.steps.e2b.complete).toBe(false);

    new VaultItems(store, broker, undefined, 'org_personal').save({
      type: 'login', label: 'Example login', secrets: { password: 'secret' },
    });
    store.createCard({ id: 'card-1', provider: 'vault', scope: 'organization', scopeId: 'org_personal',
      label: 'Workspace card', cap: 10_000, available: 10_000, createdAt: Date.now() });
    const withOptional = await (await request()).json() as any;
    expect(withOptional.steps.optional).toMatchObject({ complete: true, blocking: false, vault: true, card: true });
  });

  it('lets the operator show the guide again by forgetting sticky completion, and nothing else', async () => {
    const { store, broker, providers, tokens, request, reset } = await boot(true);
    store.upsertGitConnection({ organizationId: 'org_personal', provider: 'github',
      installationId: 'installation-1', accountLogin: 'alice', accountType: 'User' });
    broker.registerHandle('openai:first', 'sk-test');
    providers.save({ organizationId: 'org_personal', provider: 'e2b', apiKey: 'e2b-test' });
    store.createProject('First project', {}, 'org_personal');
    expect(await (await request()).json() as any).toMatchObject({ visible: false, complete: true });

    // Sticky: undoing a step later does not bring the guide back on its own.
    providers.delete('org_personal', 'e2b');
    expect(await (await request()).json() as any).toMatchObject({ visible: false, complete: true });

    // The reset is an installation write: an organization member without
    // settings:write is refused, and the records are untouched.
    const tenant = tokens.mintPrincipal('user:tenant', ['project:read', 'project:settings:write', 'task:*']).token;
    expect((await reset({ authorization: `Bearer ${tenant}` })).status).toBe(403);
    expect(await (await request()).json() as any).toMatchObject({ visible: false, complete: true });

    const projectsBefore = store.listProjects().map((project) => project.id);
    const outcome = await reset();
    expect(outcome.status).toBe(200);
    expect(await outcome.json()).toEqual({ ok: true, reset: 1 });

    // Completion is now derived from live state again: the missing E2B key
    // brings the guide back, with the other three steps still ticked.
    const shown = await (await request()).json() as any;
    expect(shown).toMatchObject({ visible: true, complete: false, display: 'expanded', completedRequired: 3 });
    expect(shown.steps.e2b.complete).toBe(false);
    expect(store.listProjects().map((project) => project.id)).toEqual(projectsBefore);
    expect(store.listGitConnections('org_personal')).toHaveLength(1);

    // Nothing left to change: the reset reports zero rather than rewriting records.
    expect(await (await reset()).json()).toEqual({ ok: true, reset: 0 });

    // A minimized guide is opened again by a reset, even before completion.
    await request('PUT', { display: 'minimized' });
    expect(await (await reset()).json()).toEqual({ ok: true, reset: 1 });
    expect((await (await request()).json() as any).display).toBe('expanded');
  });

  it('has no guide to reset on a private installation', async () => {
    const { reset } = await boot(false);
    expect((await reset()).status).toBe(404);
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
    new VaultItems(store, broker, undefined, 'org_personal').save({
      type: 'note', label: 'Deployment notes', secrets: { note: 'not a password' },
    });
    const status = await (await request()).json() as any;
    expect(status.steps.optional).toMatchObject({ vault: false, complete: false, blocking: false });
  });
});

describe('hosted onboarding completion semantics', () => {
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

  it('does not burden a pre-existing hosted account without an onboarding enrollment record', () => {
    const status = hostedOnboardingStatus({
      hosted: true,
      organizationId: 'org_established',
      facts: { github: false, agentLogin: false, e2b: false, vault: false, card: false, project: true },
    });
    expect(status).toMatchObject({ eligible: false, visible: false });
  });
});
