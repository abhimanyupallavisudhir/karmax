import crypto from 'node:crypto';
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

async function fixture(quotaBytes?: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-storage-')); dirs.push(dir);
  const store = (await Store.create(':memory:'));
  const project = (await store.createProject('Storage'));
  const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
  const managed = new LocalObjectStore(path.join(dir, 'objects'));
  const locations = new StorageLocationService(store, managed, broker, quotaBytes);
  const engine = new ObjectSnapshotEngine(managed, broker, locations);
  // The customer bucket below exists only in this process's stubbed fetch, which
  // restic cannot use: the repository server reads it for restic.
  const resources = new ProjectResourceService(store, new WorldRegistry(), engine, broker, undefined, locations, { proxyReads: true });
  return { store, project, broker, locations, resources };
}

describe('organization storage locations', () => {
  it('rejects private server-side S3 endpoints in hosted mode', async () => {
    const f = (await fixture(1024));
    const hosted = new StorageLocationService(f.store, new LocalObjectStore(path.join(dirs[dirs.length - 1]!, 'hosted')),
      f.broker, 1024, false);
    await expect(hosted.connectS3(f.project.organizationId!, { name: 'Metadata service',
      endpoint: 'http://169.254.169.254', bucket: 'tenant-data', accessKeyId: 'key', secretAccessKey: 'secret' }))
      .rejects.toThrow(/public address|https/i);
  });

  it.each(['read failure', 'read mismatch', 'read and cleanup failure', 'cleanup failure'])(
    'fails the connection and cleans up its probe after %s', async (failure) => {
      const f = (await fixture());
      const calls: string[] = [];
      vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        calls.push(method);
        if (method === 'PUT') return new Response('', { status: 200 });
        if (method === 'DELETE') return failure.includes('cleanup')
          ? new Response('delete denied', { status: 403 }) : new Response(null, { status: 204 });
        if (failure === 'read mismatch') return new Response('wrong data');
        if (failure === 'cleanup failure') return new Response('karmax storage connection test');
        return new Response('read denied', { status: 403 });
      }));
      const location = await f.locations.connectS3(f.project.organizationId!, {
        name: 'Probe failure', endpoint: 'https://objects.example', bucket: 'test-bucket',
        accessKeyId: 'key', secretAccessKey: 'secret',
      });
      const expected = failure === 'read mismatch' ? /read-back did not match/
        : failure === 'cleanup failure' ? /delete denied/ : /read denied/;
      await expect(f.locations.test(f.project.organizationId!, location.id)).rejects.toThrow(expected);
      expect(calls).toEqual(['PUT', 'GET', 'DELETE']);
      expect((await f.locations.view(f.project.organizationId!, location.id)).status).toBe('error');
      await expect((async () => (await f.locations.setDefault(f.project.organizationId!, location.id)))()).rejects.toThrow(/unavailable/);
    });

  it('enforces the managed physical-byte quota before retaining snapshot chunks', async () => {
    const f = (await fixture(4096));
    const managed = (await f.locations.defaultLocation(f.project.organizationId!));
    const attachment = (await f.store.createResourceAttachment({ organizationId: f.project.organizationId!,
      projectId: f.project.id, name: 'Large model', driver: 'volume@1', target: { kind: 'path', path: 'model' },
      access: 'read', isolation: 'fork', source: {}, credentialHandles: [], storageLocationId: managed.id,
      publish: 'discard' }));

    await expect(f.resources.importFiles(attachment.id,
      [{ path: 'model.bin', data: crypto.randomBytes(8192) }])).rejects.toThrow(/storage quota exceeded/i);
    // Nothing of the refused data is kept: only the empty repository (its key and config).
    expect((await f.locations.list(f.project.organizationId!))[0]!.usage.retainedBytes).toBeLessThan(2048);
    expect((await f.store.listResourceRevisions(attachment.id))).toHaveLength(0);

    const free = 4096 - (await f.locations.list(f.project.organizationId!))[0]!.usage.retainedBytes;
    (await f.locations.reserveUpload('upload-a', f.project.organizationId!, managed.id, free - 100, Date.now() + 60_000));
    await expect((async () => (await f.locations.reserveUpload('upload-b', f.project.organizationId!, managed.id, 200, Date.now() + 60_000)))()).rejects.toThrow(/upload quota exceeded/i);
    (await f.locations.releaseUpload('upload-a'));
    await (async () => (await f.locations.reserveUpload('upload-b', f.project.organizationId!, managed.id, 200, Date.now() + 60_000)))();
  });

  it('counts promoted artifacts against the same managed organization quota', async () => {
    const f = (await fixture(1024));
    const managed = (await f.locations.defaultLocation(f.project.organizationId!));
    const task = (await f.store.createTask({ projectId: f.project.id, title: 'Artifact', workflow: 'just-do',
      workflowVersion: '1.0.0', params: { prompt: 'artifact' } as any }));
    (await f.store.savePromotedArtifact({ id: 'artifact-1', organizationId: f.project.organizationId!,
      projectId: f.project.id, taskId: task.id, objectKey: 'artifact-1', sha256: 'abc', bytes: 800,
      mediaType: 'application/octet-stream', name: 'artifact.bin', createdAt: Date.now() }));

    expect((await f.locations.view(f.project.organizationId!, managed.id)).usage.retainedBytes).toBe(800);
    await expect((async () => (await f.locations.reserveUpload('artifact-2', f.project.organizationId!, managed.id, 300, Date.now() + 60_000)))()).rejects.toThrow(/upload quota exceeded/i);
  });

  it('prefixes new S3 locations with the brand and keeps an existing prefix on reconnect', async () => {
    const f = (await fixture(1024));
    const organizationId = f.project.organizationId!;
    const connect = (input: { id?: string; name: string; prefix?: string }) => f.locations.connectS3(organizationId, {
      endpoint: 'https://objects.example', bucket: 'tenant-data', accessKeyId: 'AKIA_TEST', secretAccessKey: 'secret', ...input });
    expect((await connect({ name: 'New' })).config.prefix).toBe(`tavya/${organizationId}`);
    const legacy = await connect({ name: 'Legacy', prefix: 'karmax/acme' });
    expect((await connect({ id: legacy.id, name: 'Legacy' })).config.prefix).toBe('karmax/acme');
  });

  it('presigns and heads objects inside a customer location\'s prefix', async () => {
    const f = (await fixture(1024));
    const requests: string[] = [];
    const stored = new Map<string, Buffer>();
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
      if (init?.method === 'PUT') { stored.set(url.pathname, Buffer.from(init.body as Uint8Array)); return new Response('', { status: 200 }); }
      if (init?.method === 'DELETE') { stored.delete(url.pathname); return new Response(null, { status: 204 }); }
      if (init?.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': '7', etag: '"e"' } });
      const value = stored.get(url.pathname);
      return value ? new Response(value, { status: 200 }) : new Response('missing', { status: 404 });
    }));
    try {
      const location = await f.locations.connectS3(f.project.organizationId!, { name: 'Data lake',
        endpoint: 'https://objects.example', bucket: 'tenant-data', region: 'eu-west-1', prefix: 'krmax/acme',
        accessKeyId: 'AKIA_TEST', secretAccessKey: 'secret' });
      const objects = await f.locations.objectStore(location.id);
      const url = new URL(await objects.presign!('PUT', 'resources/o/chunks/a.bin', 60));
      expect(`${url.origin}${url.pathname}`).toBe('https://objects.example/tenant-data/krmax/acme/resources/o/chunks/a.bin');
      requests.length = 0;
      expect(await objects.head!('resources/o/chunks/a.bin')).toEqual({ bytes: 7, etag: 'e' });
      expect(requests).toEqual(['HEAD /tenant-data/krmax/acme/resources/o/chunks/a.bin']);
    } finally { vi.unstubAllGlobals(); }
  });

  it('keeps customer S3 secrets vaulted and pins revisions to the tested location', async () => {
    const f = (await fixture(64 * 1024));
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
    (await f.locations.setDefault(f.project.organizationId!, ready.id));

    const visible = (await f.locations.list(f.project.organizationId!));
    expect(JSON.stringify(visible)).not.toContain('AKIA_TEST');
    expect(JSON.stringify(visible)).not.toContain('super-secret');
    expect(visible.find((candidate) => candidate.id === ready.id)).toMatchObject({
      kind: 's3', status: 'ready', isDefault: true, credentialConfigured: true,
    });

    // Reproduce #201 through the authenticated HTTP route: an agent from one
    // project attaches a data item in another, using an explicit S3 location.
    const origin = (await f.store.createProject('Agent origin'));
    const task = (await f.store.createTask({ projectId: origin.id, title: 'Configure data', workflow: 'just-do',
      workflowVersion: '1.0.0', params: { prompt: 'configure data' } }));
    const tokens = new TokenAuthority();
    const caps = ['project:settings:write'];
    const agent = (await tokens.mint({ taskId: task.id, profileId: 'maintainer', principal: `task:${task.id}`,
      organizationId: f.project.organizationId, ceiling: caps, grantorCaps: caps }));
    const client = { workflow: { getHandle: () => ({}) } } as any;
    const worlds = new WorldRegistry();
    const api = new KarmaxApi({ store: f.store, tokens, client, worlds, taskQueue: 'test', resources: f.resources });
    const gateway = (await Gateway.create({ api, store: f.store, tokens, client, worlds, taskQueue: 'test',
      resources: f.resources, broker: f.broker, bus: new KarmaxBus(), contributions: new ContributionRegistry(),
      overlays: new Overlays(), staticDir: 'web', agentInfo: { provider: 'mock', reason: 'S3 agent authorization test' } }));
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
      revision = (await f.store.getResourceRevision(attachment.revision.id));
    } finally { await server.close(); }
    expect(revision.storageLocationId).toBe(ready.id);
    expect([...objects.keys()].some((key) => key.includes(`/tenant-data/krmax/acme/resource-repositories/${revision.attachmentId}/${ready.id}/data/`))).toBe(true);
    // Counted against that location: the data, and restic's own metadata.
    expect((await f.locations.list(f.project.organizationId!)).find((candidate) => candidate.id === ready.id)?.usage.retainedBytes).toBeGreaterThan(4);
    await expect((async () => (await f.locations.delete(f.project.organizationId!, ready.id)))()).rejects.toThrow(/still used/i);
    // Verification uses immutable revision placement even after the head moves to managed storage.
    const managed = (await f.locations.ensureManaged(f.project.organizationId!));
    (await f.store.updateResourceAttachment(revision.attachmentId, { storageLocationId: managed.id }));
    const head = await f.resources.importFiles(revision.attachmentId, [{ path: 'new', data: Buffer.from('new') }]);
    const evidence = await f.resources.verifyRevision(f.project.id, revision.attachmentId, revision.id);
    expect(evidence).toMatchObject({ status: 'complete', storageLocationId: ready.id, verifiedBytes: 4 });
    expect(JSON.stringify(evidence)).not.toMatch(/AKIA_TEST|super-secret|objects.example|sealedRef|credential/);
    expect((await f.store.getResourceAttachment(revision.attachmentId))?.currentRevisionId).toBe(head.id);

    // Even an internally inconsistent revision cannot route reads to another tenant's location.
    const foreign = (await f.store.createOrganization({ name: 'Foreign storage' }));
    const foreignLocation = (await f.locations.ensureManaged(foreign.id));
    const ref = JSON.parse(revision.sealedRef);
    const invalid = (await f.store.saveResourceRevision({ ...revision, id: undefined,
      storageLocationId: foreignLocation.id, sealedRef: JSON.stringify({ ...ref, storageLocationId: foreignLocation.id }) }));
    await expect(f.resources.verifyRevision(f.project.id, revision.attachmentId, invalid.id))
      .rejects.toThrow('resource revision storage is unavailable');

  });
});
