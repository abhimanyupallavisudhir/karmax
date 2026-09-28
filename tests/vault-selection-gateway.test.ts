import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { Gateway } from '../src/gateway/server.js';
import { Store } from '../src/store/db.js';
import { VaultItems } from '../src/autonomy/vault-items.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { WorldRegistry } from '../src/world/registry.js';
import { findFreePortFrom } from '../src/util/ports.js';

const app = fs.readFileSync('web/app.js', 'utf8');
const sortStart = app.indexOf('function sortVaultItems(');
const sort = new vm.Script(`(${app.slice(sortStart, app.indexOf('\nfunction vaultItemSearchText', sortStart))})`).runInNewContext();

describe('credential selection ranking through HTTP', () => {
  it('returns saved-grant ranking to the picker and ignores repeated secret accesses', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-selection-http-'));
    const store = await Store.create(':memory:');
    let close: (() => Promise<void>) | undefined;
    try {
      const broker = new CredentialBroker(new Vault(path.join(home, 'vault')));
      const vault = new VaultItems(store, broker, home);
      const frequent = await vault.save({ type: 'login', label: 'Zulu - frequently selected', secrets: { password: 'test-secret' } });
      const accessed = await vault.save({ type: 'login', label: 'Alpha - frequently accessed', secrets: { password: 'another-secret' } });
      const project = await store.createProject('Selections');
      for (let i = 0; i < 3; i++) await store.createTask({ projectId: project.id, title: 'Granted task', workflow: 'software-dev', workflowVersion: '1',
        params: { prompt: '', _authorization: { capabilities: [`use-credential:item:${frequent.id}`] } } });
      for (let i = 0; i < 5; i++) await vault.resolveField(accessed, 'password', { mode: 'use' });
      const tokens = new TokenAuthority();
      const gateway = await Gateway.create({ store, broker, bus: new KarmaxBus(), tokens,
        contributions: new ContributionRegistry(), overlays: new Overlays(), client: {} as any, api: {} as any,
        taskQueue: 'test', staticDir: home, agentInfo: { provider: 'mock', reason: 'selection test' }, worlds: new WorldRegistry(),
      } as any);
      const running = await gateway.listen(await findFreePortFrom(48_400));
      close = running.close;
      const { token } = await (await fetch(`${running.url}/api/session`)).json() as any;
      const response = await fetch(`${running.url}/api/vault/items?organizationId=org_personal`, { headers: { authorization: `Bearer ${token}` } });
      expect(response.status).toBe(200);
      const payload = await response.json() as any[];
      expect(payload.find(item => item.id === frequent.id)).toMatchObject({ selectionCount: 3, useCount: 0 });
      expect(payload.find(item => item.id === accessed.id)).toMatchObject({ selectionCount: 0, useCount: 5 });
      expect(sort(payload).map((item: any) => item.id)).toEqual([frequent.id, accessed.id]);
      expect(sort(payload, new Set([accessed.id])).map((item: any) => item.id)).toEqual([accessed.id, frequent.id]);
      expect(JSON.stringify(payload)).not.toContain('test-secret');
      expect(JSON.stringify(payload)).not.toContain('another-secret');
      for (const field of ['password', 'note', 'secret', 'env', 'privateKey']) {
        const fill = await fetch(`${running.url}/api/vault/fill?organizationId=org_personal`, {
          method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ itemId: frequent.id, field, selector: '#pw' }),
        });
        expect(fill.status).toBe(400);
        expect((await fill.json() as any).error).toMatch(/login fields|domains/);
      }

      const task = await store.createTask({ projectId: project.id, title: 'Fill', workflow: 'just-do', workflowVersion: '1', params: { prompt: '' } });
      const login = await vault.save({ type: 'login', label: 'Once', domains: ['example.com'], username: 'alice', policy: { use: 'ask', reveal: 'ask' }, secrets: { password: 'pw' } });
      const grant = await vault.request({ taskId: task.id, caps: [], itemId: login.id, mode: 'use', why: 'login' });
      await vault.resolve(grant.requestId!, { action: 'once', by: 'user:test' });
      const agent = await tokens.mint({ taskId: task.id, projectId: project.id, organizationId: 'org_personal', principal: 'task:test', profileId: 'test', ceiling: ['*'], grantorCaps: ['*'] });
      (gateway as any).fillCredential = async (_taskId: string, args: any) => {
        if (args.selector === '#missing') throw new Error('missing selector');
        await args.resolveText();
        return 'https://example.com';
      };
      const fill = (field: string, selector: string) => fetch(`${running.url}/api/vault/fill`, {
        method: 'POST', headers: { authorization: `Bearer ${agent.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ itemId: login.id, field, selector }),
      });
      expect((await fill('username', '#user')).status).toBe(200);
      expect((await vault.access([], task.id, login, 'use')).status).toBe('granted');
      expect((await fill('password', '#missing')).status).toBe(400);
      expect((await vault.access([], task.id, login, 'use')).status).toBe('granted');
      expect((await fill('password', '#pw')).status).toBe(200);
      expect((await vault.access([], task.id, login, 'use')).status).toBe('needs_approval');
      const reader = await tokens.mint({ taskId: task.id, projectId: project.id, organizationId: 'org_personal',
        principal: 'task:reader', profileId: 'reader', ceiling: ['credential:read'], grantorCaps: ['credential:read'] });
      const providers = await fetch(`${running.url}/api/organizations/org_personal/agent-mail/providers`, {
        headers: { authorization: `Bearer ${reader.token}` },
      });
      expect(providers.status).toBe(200);
      const providerMetadata = await providers.json() as any;
      expect(providerMetadata.providers.length).toBeGreaterThan(0);
      expect(providerMetadata).not.toHaveProperty('webhookUrl');
      expect(providerMetadata).not.toHaveProperty('cloudflareWorker');
      const managedProviders = await fetch(`${running.url}/api/organizations/org_personal/agent-mail/providers`, {
        headers: { authorization: `Bearer ${agent.token}` },
      });
      expect(await managedProviders.json()).toHaveProperty('webhookUrl');
      // AU-12/AU-14: a passkey ceremony runs in the calling task's own browser,
      // never at an endpoint the agent names.
      const enroll = async () => {
        const response = await fetch(`${running.url}/api/vault/passkey/enroll`, {
          method: 'POST', headers: { authorization: `Bearer ${agent.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ domain: 'example.com', cdpUrl: 'http://127.0.0.1:1' }),
        });
        expect(response.status).toBe(400);
        return (await response.json() as any).error as string;
      };
      expect(await enroll()).toMatch(/call this from a task that has a world/);
      const view = { taskId: task.id, title: 'Fill', workflow: 'just-do', stage: 'do', status: 'active' } as any;
      await store.saveView(task.id, { ...view, worldPath: home, branch: 'karmax/fill' });
      expect(await enroll()).toMatch(/no agent of this task is running/);
      // Finding no browser does not spend a one-shot grant.
      const passkey = await vault.save({ type: 'passkey', label: 'Key', domains: ['example.com'], policy: { use: 'ask', reveal: 'ask' },
        secrets: { passkey: JSON.stringify([{ credentialId: 'c', rpId: 'example.com', privateKey: 'k' }]) } });
      const once = await vault.request({ taskId: task.id, caps: [], itemId: passkey.id, mode: 'use', why: 'sign in' });
      await vault.resolve(once.requestId!, { action: 'once', by: 'user:test' });
      const passkeyLogin = await fetch(`${running.url}/api/vault/passkey/login`, {
        method: 'POST', headers: { authorization: `Bearer ${agent.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ itemId: passkey.id }),
      });
      expect(passkeyLogin.status).toBe(400);
      expect((await passkeyLogin.json() as any).error).toMatch(/no agent of this task is running/);
      expect((await vault.access([], task.id, passkey, 'use')).status).toBe('granted');
      (gateway as any).deps.hosted = true;
      expect(await enroll()).toMatch(/hosted passkeys run in the task's remote world/);
      const opened: any[] = [];
      (gateway as any).openTaskWorldPage = async (...args: any[]) => { opened.push(args); throw new Error('world page opened'); };
      await store.saveView(task.id, { ...view, world: { kind: 'container', id: task.id, root: home, branch: 'karmax/fill', base: 'main' } });
      expect(await enroll()).toBe('world page opened');
      expect(opened).toEqual([[task.id, expect.objectContaining({ kind: 'container' }), ['example.com']]]);
      // …nor does a world browser without the page (#367 review item 16).
      const worldLogin = await fetch(`${running.url}/api/vault/passkey/login`, {
        method: 'POST', headers: { authorization: `Bearer ${agent.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ itemId: passkey.id }),
      });
      expect((await worldLogin.json() as any).error).toBe('world page opened');
      expect((await vault.access([], task.id, passkey, 'use')).status).toBe('granted');


    } finally {
      await close?.();
      await store.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
