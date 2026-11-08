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
import { MODEL_LOGINS_MOVED_MARKER } from '../src/autonomy/model-logins.js';

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
    // A secondary attaches only once the primary has moved the model logins into the vault (data epoch 6).
    await expect(createExecutionServices(input)).rejects.toThrow(/model logins have not moved into the vault/);
    await store.kvSet(MODEL_LOGINS_MOVED_MARKER, '{}');
    const secondary = await createExecutionServices(input);
    expect(await store.listProfiles()).toEqual([]);
    expect(await secondary.providerConnections.list('org_personal')).toEqual([]);
    expect(await store.listStorageLocations('org_personal')).toEqual([]);
    expect(await broker.listHandles()).toEqual([]);
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

// R2 has no object versioning, and backups skip an external object store, so
// a restored database must still find the objects deleted since its backup.
it('delays deleting managed objects in an S3 store and deletes local ones at once', async () => {
  const { DeferredDeleteObjectStore } = await import('../src/store/deferred-delete.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-execution-services-'));
  vi.stubEnv('KARMAX_HOME', home);
  vi.stubEnv('E2B_API_KEY', '');
  vi.stubEnv('DAYTONA_API_KEY', '');
  const requests: string[] = [];
  vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
    requests.push(`${init.method} ${new URL(url).pathname}`);
    return new Response(init.method === 'GET' ? 'data' : null, { status: 200 });
  });
  const p = ensurePaths(home);
  const store = await Store.create(':memory:');
  try {
    const broker = new CredentialBroker(new Vault(p.vault));
    const githubApp = await GitHubAppService.create(store, broker);
    const input = { store, broker, githubApp, p, client: {} as Client,
      deployment: { hosted: false, hostLocal: true }, provider: 'mock' as const };

    vi.stubEnv('KARMAX_OBJECT_STORE', 'local');
    await store.kvSet(MODEL_LOGINS_MOVED_MARKER, '{}'); // as the primary's boot leaves it
    const local = await createExecutionServices(input);
    expect(local.objectStore).toBeInstanceOf(DeferredDeleteObjectStore);
    await local.objectStore.put('artifacts/o/p/t/a', Buffer.from('x'));
    await local.objectStore.delete('artifacts/o/p/t/a');
    expect(fs.existsSync(path.join(p.objects, 'artifacts/o/p/t/a'))).toBe(false);

    vi.stubEnv('KARMAX_OBJECT_STORE', 's3');
    vi.stubEnv('KARMAX_S3_ENDPOINT', 'https://account.eu.r2.cloudflarestorage.com');
    vi.stubEnv('KARMAX_S3_BUCKET', 'tavya-objects');
    vi.stubEnv('KARMAX_S3_REGION', 'auto');
    vi.stubEnv('KARMAX_S3_ACCESS_KEY_ID', 'id');
    vi.stubEnv('KARMAX_S3_SECRET_ACCESS_KEY', 'secret');
    const s3 = await createExecutionServices(input);
    await s3.objectStore.delete('artifacts/o/p/t/a');
    expect(requests).toEqual([]);
    const tombstone = await store.objectTombstone('artifacts/o/p/t/a');
    expect(tombstone!.purgeAfter - tombstone!.deletedAt).toBe(30 * 24 * 60 * 60_000);
    // Every managed-storage consumer gets the same wrapped store.
    expect(await s3.storageLocations.objectStore((await s3.storageLocations.ensureManaged('org_personal')).id))
      .toBe(s3.objectStore);
  } finally {
    vi.unstubAllGlobals();
    await store.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// 2026-11-08: boot asked each cloud world's `status`, and a VM world's asks the
// cloud in a fresh process, one world after another. ~330 worlds kept boot past
// the healthcheck and tavya.io was unreachable for an hour. Boot only opens
// each reference, locally, and still names the ones that will not open.
it('checks every cloud world reference at boot without asking a provider', async () => {
  const { VmWorldProvider } = await import('../src/world/vm/provider.js');
  const { WorldReferenceKeys } = await import('../src/world/reference-keys.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-execution-services-'));
  vi.stubEnv('KARMAX_HOME', home);
  vi.stubEnv('KARMAX_OBJECT_STORE', 'local');
  vi.stubEnv('E2B_API_KEY', '');
  vi.stubEnv('DAYTONA_API_KEY', '');
  const probe = vi.spyOn(VmWorldProvider.prototype, 'probe');
  const status = vi.spyOn(VmWorldProvider.prototype, 'status');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const p = ensurePaths(home);
  const store = await Store.create(':memory:');
  try {
    const broker = new CredentialBroker(new Vault(p.vault));
    const githubApp = await GitHubAppService.create(store, broker);
    const keys = await WorldReferenceKeys.create(broker);
    const world = (id: string, kind: string, state: string, sealedProviderRef?: string) => store.db
      .prepare('INSERT INTO world_instances (worldId, generation, handle, state, createdAt, updatedAt) VALUES (?, 1, ?, ?, 1, 1)')
      .run(id, JSON.stringify({ version: 2, kind, provider: kind, id, root: '/home/user', ...(sealedProviderRef ? { sealedProviderRef } : {}) }), state);
    await world('task_parked_vm', 'hetzner', 'parked', keys.seal({ sshKey: 'k', hostKey: 'h', server: '1', volume: '2' }));
    await world('task_hibernated_vm', 'fly', 'hibernated', keys.seal({ sshKey: 'k', hostKey: 'h', app: 'a', machine: 'm' }));
    await world('task_lost_key', 'e2b', 'hibernated', 'KWR2.0123456789abcdef.body');

    await createExecutionServices({ store, broker, githubApp, p, client: {} as Client,
      deployment: { hosted: false, hostLocal: true }, provider: 'mock', bootstrap: true });

    expect(probe).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    const warnings = warn.mock.calls.map((call) => String(call[0]));
    expect(warnings.find((line) => /world reference\(s\) cannot be opened/.test(line))).toMatch(/^1 world reference\(s\)/);
  } finally {
    probe.mockRestore(); status.mockRestore(); warn.mockRestore();
    await store.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
