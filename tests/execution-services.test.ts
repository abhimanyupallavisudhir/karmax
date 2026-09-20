import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Client } from '@temporalio/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../src/store/db.js';
import { ensurePaths } from '../src/config/paths.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { GitHubAppService } from '../src/integrations/github-app.js';
import { createExecutionServices } from '../src/runtime/execution-services.js';

afterEach(() => vi.unstubAllEnvs());

it('attaches a secondary process without seeding profiles, importing credentials or creating managed storage', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-execution-services-'));
  vi.stubEnv('KARMAX_HOME', home);
  vi.stubEnv('KARMAX_OBJECT_STORE', 'local');
  vi.stubEnv('E2B_API_KEY', 'fixture-provider-key');
  vi.stubEnv('DAYTONA_API_KEY', '');
  const p = ensurePaths(home);
  const store = await Store.create(':memory:');
  try {
    const broker = new CredentialBroker(new Vault(p.vault));
    const githubApp = await GitHubAppService.create(store, broker);
    const input = { store, broker, githubApp, p, client: {} as Client,
      deployment: { hosted: false, hostLocal: true }, provider: 'mock' as const };
    const secondary = await createExecutionServices(input);
    expect(await store.listProfiles()).toEqual([]);
    expect(await secondary.providerConnections.list('org_personal')).toEqual([]);
    expect(await store.listStorageLocations('org_personal')).toEqual([]);
    expect(broker.listHandles()).toEqual([]);
    const primary = await createExecutionServices({ ...input, bootstrap: true });
    expect((await store.listProfiles()).length).toBeGreaterThan(0);
    expect(await primary.providerConnections.get('org_personal', 'e2b')).toMatchObject({ credentialConfigured: true });
    expect((await store.listStorageLocations('org_personal')).length).toBeGreaterThan(0);
    expect(primary.worlds.get('worktree').kind).toBe('worktree');
  } finally {
    await store.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
