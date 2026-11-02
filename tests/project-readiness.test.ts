import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IdentityService } from '../src/auth/identity.js';
import { AuthorizationService } from '../src/platform/authorization.js';
import { Gateway } from '../src/gateway/server.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { findFreePortFrom } from '../src/util/ports.js';
import { WorldRegistry } from '../src/world/registry.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { Vault } from '../src/autonomy/vault.js';
import { MANAGED_COMPUTE, WorldProviderConnectionService } from '../src/world/connections.js';
import { INSTALLATION_SCOPE } from '../src/autonomy/vault-keys.js';
import { credPolicyKey } from '../src/platform/credential-sources.js';
import { managedStorageLocationId } from '../src/store/storage-locations.js';

const closers: Array<() => Promise<void>> = [];
afterAll(async () => { for (const close of closers) await close().catch(() => {}); });

/** A signed-in owner of `org_personal` with one project, on a hosted (or self-hosted) gateway. */
async function boot(hosted: boolean) {
  const port = await findFreePortFrom(48330);
  const identity = await IdentityService.open(':memory:', { baseURL: `http://127.0.0.1:${port}` });
  const store = await Store.create(':memory:', { hosted });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-readiness-'));
  const broker = new CredentialBroker(new Vault(dir));
  const providers = new WorldProviderConnectionService(store, broker);
  const gateway = await Gateway.create({
    api: {} as any, store, bus: new KarmaxBus(), tokens: new TokenAuthority(), contributions: new ContributionRegistry(),
    overlays: new Overlays(), client: {} as any, taskQueue: 'test', staticDir: process.cwd(),
    agentInfo: { provider: 'mock', reason: 'readiness test' }, identity,
    authorization: await AuthorizationService.create(store), worlds: new WorldRegistry(), broker,
    providerConnections: providers, hosted,
  });
  const running = await gateway.listen(port);
  closers.push(async () => { await running.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const setup = await fetch(`${running.url}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Nadia', email: 'nadia@example.com', password: 'long-enough-password' }) });
  expect(setup.status).toBe(200);
  const cookie = setup.headers.get('set-cookie')?.match(/better-auth\.session_token=[^;]+/)?.[0] ?? '';
  const project = await store.createProject('Readiness', {}, 'org_personal');
  const readiness = async (...agents: string[]) => {
    const query = new URLSearchParams(agents.map((agent): [string, string] => ['agent', agent]));
    const res = await fetch(`${running.url}/api/projects/${project.id}/readiness?${query}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    return res.json() as Promise<any>;
  };
  return { store, broker, providers, project, readiness };
}

describe('project readiness: can a task here start?', () => {
  it('names each missing essential on a hosted organization, by the rules the run applies', async () => {
    const { store, broker, providers, project, readiness } = await boot(true);
    expect(await readiness('claude:claude-opus-5-5', 'codex')).toEqual({
      agents: [{ provider: 'claude', model: 'claude-opus-5-5', ready: false }, { provider: 'codex', ready: false }],
      agentLogin: false,
      compute: { ready: false, local: false, managed: false, own: false, need: 'computer' },
    });

    // An OpenAI key runs Codex, not Claude.
    await broker.registerHandle('openai:first', 'sk-test', INSTALLATION_SCOPE);
    expect((await readiness('claude', 'codex')).agents.map((agent: any) => agent.ready)).toEqual([false, true]);
    // Switched off for this project, it runs nothing here.
    await store.kvSet(credPolicyKey.project(project.id), JSON.stringify({ off: ['key:handle:openai:first'] }));
    expect(await readiness('codex')).toMatchObject({ agents: [{ provider: 'codex', ready: false }], agentLogin: false });
    await store.kvDelete(credPolicyKey.project(project.id));

    // A compute account of the organization's own.
    await providers.save({ organizationId: 'org_personal', provider: 'e2b', apiKey: 'e2b_test' });
    expect((await readiness()).compute).toEqual({ ready: true, local: false, managed: false, own: true });
  });

  it('says tavya’s computers are out of credit, and takes a gifted pack as compute', async () => {
    const { store, providers, readiness } = await boot(true);
    await providers.save({ organizationId: MANAGED_COMPUTE, provider: 'e2b', apiKey: 'e2b_managed' });
    const never = (await readiness()).compute;
    expect(never).toMatchObject({ ready: false, managed: false, own: false, need: 'plan' });
    expect(never.outOfCredit).toMatch(/^Out of compute: .*paid plan/);
    await store.setComputePackGift('org_personal', 1, 'operator');
    expect((await readiness()).compute).toEqual({ ready: true, local: false, managed: true, own: false });
    // This month's $10 spent (at twice the provider's $5.50): more credit, not a plan, is what it needs.
    const now = Date.now(), monthStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1);
    await store.recordUsage({ id: 'usage:e2b:spent', organizationId: 'org_personal', provider: 'e2b', kind: 'world.active', quantity: 3600,
      unit: 'second', costMicros: 5_500_000, startedAt: Math.max(monthStart, now - 3_600_000), endedAt: now, fundingSource: 'managed' });
    const spent = (await readiness()).compute;
    expect(spent).toMatchObject({ ready: false, need: 'credit' });
    expect(spent.outOfCredit).toMatch(/^Out of compute: this month's \$10\.00 of compute is used up/);
  });

  it('says when managed storage is full, which does not stop a task', async () => {
    const { store, readiness } = await boot(true);
    const id = managedStorageLocationId('org_personal');
    await store.saveStorageLocation({ id, organizationId: 'org_personal', name: 'Managed storage', kind: 'managed', config: {},
      isDefault: true, status: 'ready', createdAt: Date.now(), updatedAt: Date.now() });
    expect((await readiness()).storage).toEqual({ full: false, usedBytes: 0, quotaBytes: 5 * 1024 ** 3 });
    await store.db.prepare(`INSERT INTO resource_snapshot_chunks (organizationId, chunkId, storageLocationId, refs, bytes)
      VALUES (?, ?, ?, 1, ?)`).run('org_personal', 'chunk-full', id, 6 * 1024 ** 3);
    expect((await readiness()).storage).toEqual({ full: true, usedBytes: 6 * 1024 ** 3, quotaBytes: 5 * 1024 ** 3 });
  });

  it('runs self-hosted tasks on the machine itself', async () => {
    const { readiness } = await boot(false);
    const local = await readiness();
    expect(local.compute).toEqual({ ready: true, local: true, managed: false, own: false });
    expect(local.storage).toBeUndefined();
  });

  it('ignores an agent it does not know rather than calling it unready', async () => {
    const { readiness } = await boot(true);
    expect((await readiness('nonsense:model')).agents).toEqual([]);
  });
});
