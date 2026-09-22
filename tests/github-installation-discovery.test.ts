import { expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { GitHubAppService } from '../src/integrations/github-app.js';

it('discovers all pages, requires organization ownership, and does not reuse another active account mid-request', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'github-discovery-'));
  const store = await Store.create(':memory:');
  const broker = new CredentialBroker(new Vault(dir));
  const pages: string[] = [];
  let malformed = false;
  let membershipFails = false;
  let switchAccount = false;
  const service = await GitHubAppService.create(store, broker, { appId: '123', fetch: (async (input, init) => {
    const url = new URL(String(input));
    const token = new Headers(init?.headers).get('authorization');
    if (url.pathname === '/user') {
      if (switchAccount) await store.kvSet('github-app:user:me:active-account', '2');
      return Response.json(token?.includes('second-token') ? { id: 2, login: 'second' } : { id: 1, login: 'owner' });
    }
    expect(token).toContain('first-token');
    if (url.pathname === '/user/installations') {
      pages.push(url.searchParams.get('page')!);
      if (malformed) return Response.json({});
      return Response.json({ installations: url.searchParams.get('page') === '1'
        ? Array.from({ length: 100 }, (_, index) => ({ id: index + 1, account: { login: 'foreign', type: 'User' } }))
        : [{ id: 101, account: { login: 'owner', type: 'User' } },
          { id: 102, account: { login: 'owned-org', type: 'Organization' } },
          { id: 103, account: { login: 'member-org', type: 'Organization' } },
          { id: 104, account: { login: 'owner', type: 'User' }, suspended_at: '2026-01-01T00:00:00Z' }] });
    }
    if (membershipFails) return Response.json({ message: 'not allowed' }, { status: 403 });
    return Response.json({ state: 'active', role: url.pathname.endsWith('owned-org') ? 'admin' : 'member' });
  }) as typeof fetch });
  try {
    await service.adoptUserAuthorization('me', '1', { accessToken: 'first-token' });
    await service.adoptUserAuthorization('me', '2', { accessToken: 'second-token' });
    switchAccount = true;
    expect(await service.connectableInstallations('me')).toEqual([
      { id: '101', accountLogin: 'owner', accountType: 'User' },
      { id: '102', accountLogin: 'owned-org', accountType: 'Organization' },
    ]);
    expect(pages).toEqual(['1', '2']);
    switchAccount = false;
    // Restore the first account through the public API before subsequent requests.
    await service.setActiveUserAccount('me', '1');
    malformed = true;
    await expect(service.connectableInstallations('me')).rejects.toThrow('no installation list');
    malformed = false;
    membershipFails = true;
    await expect(service.connectableInstallations('me')).rejects.toThrow('403');
    expect(await store.gitConnectionsForInstallation('github', '101')).toEqual([]);
  } finally { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
