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
      const gateway = await Gateway.create({ store, broker, bus: new KarmaxBus(), tokens: new TokenAuthority(),
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

    } finally {
      await close?.();
      await store.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
