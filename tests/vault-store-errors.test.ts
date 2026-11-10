// tavya.error 4d9a1394a8db6a67 / 89856e3dbd2384b1 (2026-11-10): an agent sent
// POST /api/vault/store {id, type: "login", …} for its ssh-key and api-key
// items (browser fill typed only logins), and VaultItems.save refused with a
// bare Error the gateway answered as an unexpected 500. Every refusal on a
// vault write is the caller's to fix: typed, 4xx, with its message.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { memoryTransaction } from './helpers/memory-transaction.js';
import { Gateway } from '../src/gateway/server.js';
import { Store } from '../src/store/db.js';
import { VaultItems, type VaultItemStore } from '../src/autonomy/vault-items.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { Connectors } from '../src/autonomy/connectors.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { WorldRegistry } from '../src/world/registry.js';
import { findFreePortFrom } from '../src/util/ports.js';
import { errorStatus } from '../src/gateway/error-status.js';

function memVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-vault-errors-'));
  const kv = new Map<string, string>();
  const store: VaultItemStore = { transaction: memoryTransaction(kv), kvGet: (k) => kv.get(k), kvSet: (k, v) => void kv.set(k, v), appendAudit: () => 0 };
  const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
  return { items: new VaultItems(store, broker, path.join(dir, 'state')), store, broker };
}

const refusal = async (write: Promise<unknown>) => {
  const error = await write.then(() => undefined, (e: unknown) => e);
  expect(error, 'the write should have been refused').toBeInstanceOf(Error);
  return { status: errorStatus(error, 500), message: (error as Error).message };
};

describe('VaultItems.save refusals', () => {
  it('keeps an item\'s type on an update that omits it', async () => {
    const { items } = memVault();
    const key = await items.save({ type: 'ssh-key', label: 'Deploy key', secrets: { privateKey: 'old' } });
    const rotated = await items.save({ id: key.id, secrets: { privateKey: 'new' } });
    expect(rotated).toMatchObject({ id: key.id, type: 'ssh-key', label: 'Deploy key' });
    expect(await items.readSecret(rotated, 'privateKey')).toBe('new');
  });

  it('answers every caller error with a 4xx and its reason', async () => {
    const { items } = memVault();
    const key = await items.save({ type: 'ssh-key', label: 'Deploy key', secrets: { privateKey: 'k' } });
    expect(await refusal(items.save({ id: key.id, type: 'login', secrets: { password: 'k' } })))
      .toEqual({ status: 409, message: expect.stringMatching(/is a ssh-key, not a login: an item's type cannot change/) });
    expect(await refusal(items.save({ type: 'bogus' as any, label: 'x' }))).toMatchObject({ status: 400, message: expect.stringMatching(/unknown vault item type "bogus"/) });
    expect(await refusal(items.save({ label: 'no type' }))).toMatchObject({ status: 400, message: expect.stringMatching(/needs a type/) });
    expect(await refusal(items.save({ id: 'vi_missing', secrets: { password: 'x' } }))).toMatchObject({ status: 404 });
    expect(await refusal(items.save({ type: 'login', label: '  ' }))).toMatchObject({ status: 400, message: 'a vault item needs a label' });
    expect(await refusal(items.save({ type: 'note', label: 'n', secrets: { note: ' ' } }))).toMatchObject({ status: 400 });
    expect(await refusal(items.save({ type: 'api-key', label: 'k', envVar: '1BAD' }))).toMatchObject({ status: 400 });
    expect(await refusal(items.save({ type: 'login', label: 'big', secrets: { password: 'x'.repeat(70_000) } }))).toMatchObject({ status: 400 });
    expect(await refusal(items.save({ type: 'session', label: 's', domains: ['example.com'], secrets: { session: 'not json' } }))).toMatchObject({ status: 400 });
    expect(await refusal(items.save({ type: 'session', label: 's' }))).toMatchObject({ status: 400 });
    // The refused writes changed nothing.
    expect((await items.get(key.id))).toMatchObject({ type: 'ssh-key' });
  });

  it('answers a decision on an already-resolved credential request with a 409', async () => {
    const { items } = memVault();
    const login = await items.save({ type: 'login', label: 'L', policy: { use: 'ask', reveal: 'ask' }, secrets: { password: 'p' } });
    const asked = await items.request({ taskId: 'task_x', caps: [], itemId: login.id, mode: 'use', why: 'sign in' });
    await items.resolve(asked.requestId!, { action: 'once', by: 'user:a' });
    expect(await refusal(items.resolve(asked.requestId!, { action: 'deny', by: 'user:b' }))).toMatchObject({ status: 409 });
    expect(await refusal(items.resolve('vreq_missing', { action: 'deny', by: 'user:b' }))).toMatchObject({ status: 404 });
  });

  it('lets a connector sync go on past one entry the vault refuses', async () => {
    const { items, store, broker } = memVault();
    let types: Record<string, 'login' | 'api-key'> = { a: 'login', b: 'login' };
    let password = 'one';
    const connector = {
      name: 'test',
      describe: async () => ({ name: 'test', label: 'Test', available: true, canPush: false, detail: 'ready' }),
      list: async () => Object.keys(types).map((externalId) => ({ externalId, type: types[externalId]!, label: externalId, fields: [] as any[] })),
      pull: async (ids: string[]) => ({ failures: [], items: ids.map((externalId) => ({ externalId, type: types[externalId]!, label: externalId,
        fields: [] as any[], secrets: types[externalId] === 'login' ? { password } : { secret: password } })) }),
    };
    const connectors = new Connectors(store, items, broker);
    connectors.register(connector as any);
    await connectors.sync('test', ['a', 'b']);
    types = { a: 'login', b: 'api-key' };
    password = 'two';
    const second = await connectors.sync('test', ['a', 'b']);
    expect(second.failures).toEqual([{ externalId: 'b', error: expect.stringMatching(/is a login, not a api-key/) }]);
    const a = (await items.list()).find((item) => item.label === 'a')!;
    expect(await items.readSecret(a, 'password')).toBe('two');
  });
});

describe('vault writes over HTTP', () => {
  it('answers the 2026-11-10 calls with a 409, updates by id without a type, and fills keys', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-vault-store-http-'));
    const store = await Store.create(':memory:');
    let close: (() => Promise<void>) | undefined;
    try {
      const broker = new CredentialBroker(new Vault(path.join(home, 'vault')));
      const vault = new VaultItems(store, broker, home);
      const project = await store.createProject('Vault errors');
      const task = await store.createTask({ projectId: project.id, title: 'Staging', workflow: 'just-do', workflowVersion: '1', params: { prompt: '' } });
      const own = { source: `task:${task.id}`, taskId: task.id };
      const deployKey = await vault.save({ type: 'ssh-key', label: 'Staging deploy key', domains: ['github.com'], policy: { use: 'auto', reveal: 'ask' }, secrets: { privateKey: 'PRIVATE KEY' }, provenance: own });
      const token = await vault.save({ type: 'api-key', label: 'STAGING_SMOKE_TOKEN', domains: ['github.com'], policy: { use: 'auto', reveal: 'ask' }, secrets: { secret: 'smoke-token' }, provenance: own });
      const tokens = new TokenAuthority();
      const gateway = await Gateway.create({ store, broker, bus: new KarmaxBus(), tokens,
        contributions: new ContributionRegistry(), overlays: new Overlays(), client: {} as any, api: { viaParent: async () => undefined, tellParentOf: async () => undefined } as any,
        taskQueue: 'test', staticDir: home, agentInfo: { provider: 'mock', reason: 'vault store errors' }, worlds: new WorldRegistry(),
      } as any);
      const running = await gateway.listen(await findFreePortFrom(48_600));
      close = running.close;
      const agent = await tokens.mint({ taskId: task.id, projectId: project.id, organizationId: 'org_personal', principal: `task:${task.id}`, profileId: 'test', ceiling: ['*'], grantorCaps: ['*'] });
      const post = async (route: string, body: unknown, bearer = agent.token) => {
        const response = await fetch(`${running.url}${route}`, { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
        return { status: response.status, body: await response.json() as any };
      };

      // The two calls of 2026-11-10 08:45:20 UTC.
      expect(await post('/api/vault/store', { id: deployKey.id, type: 'login', label: 'Staging deploy key', username: 'deploy', domains: ['github.com'], secrets: { password: 'PRIVATE KEY' } }))
        .toMatchObject({ status: 409, body: { error: expect.stringMatching(/is a ssh-key, not a login/) } });
      expect(await post('/api/vault/store', { id: token.id, type: 'login', label: 'STAGING_SMOKE_TOKEN', secrets: { password: 'smoke-token' } }))
        .toMatchObject({ status: 409, body: { error: expect.stringMatching(/is a api-key, not a login/) } });
      // The wiki's rotation recipe: {id, secrets} and nothing else.
      const rotated = await post('/api/vault/store', { id: deployKey.id, secrets: { privateKey: 'NEW KEY' } });
      expect(rotated).toMatchObject({ status: 200, body: { id: deployKey.id, type: 'ssh-key', label: 'Staging deploy key' } });
      expect(await vault.readSecret((await vault.get(deployKey.id))!, 'privateKey')).toBe('NEW KEY');
      expect(await post('/api/vault/store', { type: 'bogus', label: 'x' })).toMatchObject({ status: 400 });
      expect(await post('/api/vault/store', { label: 'no type', secrets: { secret: 's' } })).toMatchObject({ status: 400 });
      // The console's item form, the same way.
      const { token: session } = await (await fetch(`${running.url}/api/session`)).json() as any;
      expect(await post('/api/vault/items?organizationId=org_personal', { id: token.id, type: 'ssh-key', label: 'x' }, session)).toMatchObject({ status: 409 });
      expect(await post('/api/vault/items?organizationId=org_personal', { id: token.id, tags: ['ci'] }, session))
        .toMatchObject({ status: 200, body: { type: 'api-key', label: 'STAGING_SMOKE_TOKEN', tags: ['ci'] } });

      // What the agent wanted: type the key itself into GitHub's secret form.
      const typed: string[] = [];
      (gateway as any).fillCredential = async (_taskId: string, args: any) => { typed.push(await args.resolveText()); return 'https://github.com'; };
      expect(await post('/api/vault/fill', { itemId: deployKey.id, selector: '#secret_value' })).toMatchObject({ status: 200, body: { filled: true } });
      expect(await post('/api/vault/fill', { itemId: token.id, field: 'secret', selector: '#secret_value' })).toMatchObject({ status: 200, body: { filled: true } });
      expect(typed).toEqual(['NEW KEY', 'smoke-token']);
      expect(await post('/api/vault/fill', { itemId: token.id, field: 'password', selector: '#secret_value' }))
        .toMatchObject({ status: 400, body: { error: expect.stringMatching(/"STAGING_SMOKE_TOKEN" is a api-key/) } });
    } finally {
      await close?.();
      await store.close?.();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
