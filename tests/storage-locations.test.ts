import { findFreePortFrom } from '../src/util/ports.js';
import { Gateway } from '../src/gateway/server.js';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { LocalObjectStore } from '../src/store/objects.js';
import { StorageLocationService } from '../src/store/storage-locations.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { ObjectSnapshotEngine, ProjectResourceService } from '../src/world/resources.js';
import { WorldRegistry } from '../src/world/registry.js';

const dirs: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function fixture(quotaBytes?: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-storage-')); dirs.push(dir);
  const store = new Store(':memory:');
  const project = store.createProject('Storage');
  const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
  const managed = new LocalObjectStore(path.join(dir, 'objects'));
  const locations = new StorageLocationService(store, managed, broker, quotaBytes);
  const engine = new ObjectSnapshotEngine(managed, broker, locations);
  const resources = new ProjectResourceService(store, new WorldRegistry(), engine, broker, undefined, locations);
  return { store, project, broker, locations, resources };
}

describe('organization storage locations', () => {
  it('rejects private server-side S3 endpoints in hosted mode', async () => {
    const f = fixture(1024);
    const hosted = new StorageLocationService(f.store, new LocalObjectStore(path.join(dirs[dirs.length - 1]!, 'hosted')),
      f.broker, 1024, false);
    await expect(hosted.connectS3(f.project.organizationId!, { name: 'Metadata service',
      endpoint: 'http://169.254.169.254', bucket: 'tenant-data', accessKeyId: 'key', secretAccessKey: 'secret' }))
      .rejects.toThrow(/public address|https/i);
  });

  it('enforces the managed physical-byte quota before retaining snapshot chunks', async () => {
    const f = fixture(1024);
    const managed = f.locations.defaultLocation(f.project.organizationId!);
    const attachment = f.store.createResourceAttachment({ organizationId: f.project.organizationId!,
      projectId: f.project.id, name: 'Large model', driver: 'volume@1', target: { kind: 'path', path: 'model' },
      access: 'read', isolation: 'fork', source: {}, credentialHandles: [], storageLocationId: managed.id,
      publish: 'discard' });

    await expect(f.resources.importFiles(attachment.id,
      [{ path: 'model.bin', data: Buffer.alloc(2048, 7) }])).rejects.toThrow(/storage quota exceeded/i);
    expect(f.locations.list(f.project.organizationId!)[0]!.usage.retainedBytes).toBe(0);
    expect(f.store.listResourceRevisions(attachment.id)).toHaveLength(0);

    f.locations.reserveUpload('upload-a', f.project.organizationId!, managed.id, 700, Date.now() + 60_000);
    expect(() => f.locations.reserveUpload('upload-b', f.project.organizationId!, managed.id, 400, Date.now() + 60_000))
      .toThrow(/upload quota exceeded/i);
    f.locations.releaseUpload('upload-a');
    expect(() => f.locations.reserveUpload('upload-b', f.project.organizationId!, managed.id, 400, Date.now() + 60_000))
      .not.toThrow();
  });

  it('counts promoted artifacts against the same managed organization quota', () => {
    const f = fixture(1024);
    const managed = f.locations.defaultLocation(f.project.organizationId!);
    const task = f.store.createTask({ projectId: f.project.id, title: 'Artifact', workflow: 'just-do',
      workflowVersion: '1.0.0', params: { prompt: 'artifact' } as any });
    f.store.savePromotedArtifact({ id: 'artifact-1', organizationId: f.project.organizationId!,
      projectId: f.project.id, taskId: task.id, objectKey: 'artifact-1', sha256: 'abc', bytes: 800,
      mediaType: 'application/octet-stream', name: 'artifact.bin', createdAt: Date.now() });

    expect(f.locations.view(f.project.organizationId!, managed.id).usage.retainedBytes).toBe(800);
    expect(() => f.locations.reserveUpload('artifact-2', f.project.organizationId!, managed.id, 300, Date.now() + 60_000))
      .toThrow(/upload quota exceeded/i);
  });

  it('keeps customer S3 secrets vaulted and pins revisions to the tested location', async () => {
    const f = fixture(1024);
    const objects = new Map<string, Buffer>();
    const httpFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const key = String(input);
      if (!key.startsWith('https://objects.example/')) return httpFetch(input, init);
      if (init?.method === 'PUT') { objects.set(key, Buffer.from(init.body as Uint8Array)); return new Response('', { status: 200 }); }
      if (init?.method === 'DELETE') { objects.delete(key); return new Response(null, { status: 204 }); }
      const value = objects.get(key); return value ? new Response(value, { status: 200 }) : new Response('missing', { status: 404 });
    }));
    const location = await f.locations.connectS3(f.project.organizationId!, { name: 'Data lake',
      endpoint: 'https://objects.example', bucket: 'tenant-data', region: 'eu-west-1', prefix: 'krmax/acme',
      accessKeyId: 'AKIA_TEST', secretAccessKey: 'super-secret' });
    const ready = await f.locations.test(f.project.organizationId!, location.id);
    f.locations.setDefault(f.project.organizationId!, ready.id);

    const visible = f.locations.list(f.project.organizationId!);
    expect(JSON.stringify(visible)).not.toContain('AKIA_TEST');
    expect(JSON.stringify(visible)).not.toContain('super-secret');
    expect(visible.find((candidate) => candidate.id === ready.id)).toMatchObject({
      kind: 's3', status: 'ready', isDefault: true, credentialConfigured: true,
    });

    // Reproduce #201 through the authenticated HTTP route: an agent from one
    // project attaches a data item in another, using an explicit S3 location.
    const origin = f.store.createProject('Agent origin');
    const task = f.store.createTask({ projectId: origin.id, title: 'Configure data', workflow: 'just-do',
      workflowVersion: '1.0.0', params: { prompt: 'configure data' } });
    const tokens = new TokenAuthority();
    const caps = ['project:settings:write'];
    const agent = tokens.mint({ taskId: task.id, profileId: 'maintainer', principal: `task:${task.id}`,
      organizationId: f.project.organizationId, ceiling: caps, grantorCaps: caps });
    const client = { workflow: { getHandle: () => ({}) } } as any;
    const worlds = new WorldRegistry();
    const api = new KarmaxApi({ store: f.store, tokens, client, worlds, taskQueue: 'test', resources: f.resources });
    const gateway = new Gateway({ api, store: f.store, tokens, client, worlds, taskQueue: 'test',
      resources: f.resources, broker: f.broker, bus: new KarmaxBus(), contributions: new ContributionRegistry(),
      overlays: new Overlays(), staticDir: 'web', agentInfo: { provider: 'mock', reason: 'S3 agent authorization test' } });
    const server = await gateway.listen(await findFreePortFrom(49_800));
    let revision: any;
    try {
      const response = await httpFetch(`${server.url}/api/projects/${f.project.id}/resources`, {
        method: 'POST', headers: { authorization: `Bearer ${agent.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Dataset', driver: 'object-tree@1', target: { kind: 'path', path: 'data' },
          storageLocationId: ready.id, files: [{ path: 'rows.bin', data: 'rows', encoding: 'utf8' }] }),
      });
      expect(response.status).toBe(200);
      const attachment = await response.json() as any;
      expect(attachment.storageLocationId).toBe(ready.id);
      revision = f.store.getResourceRevision(attachment.revision.id);
    } finally { await server.close(); }
    expect(revision.storageLocationId).toBe(ready.id);
    expect([...objects.keys()].some((key) => key.includes('/tenant-data/krmax/acme/resources/'))).toBe(true);
    expect(f.locations.list(f.project.organizationId!).find((candidate) => candidate.id === ready.id)?.usage.retainedBytes).toBe(4);
    expect(() => f.locations.delete(f.project.organizationId!, ready.id)).toThrow(/still used/i);
  });
});
