import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { WorldRegistry } from '../src/world/registry.js';
import { ObjectSnapshotEngine, ProjectResourceService } from '../src/world/resources.js';

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revision-verify-'));
  const store = (await Store.create(':memory:'));
  const project = (await store.createProject('Historical verification'));
  const data = new Map<string, Buffer>();
  const objects = {
    async put(key: string, value: Buffer) { data.set(key, value); },
    async get(key: string) { if (!data.has(key)) throw new Error('SECRET URL /private/key missing'); return data.get(key)!; },
    async delete(key: string) { data.delete(key); },
  };
  const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
  const engine = new ObjectSnapshotEngine(objects, broker);
  const service = new ProjectResourceService(store, new WorldRegistry(), engine, broker);
  const resource = (await store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
    name: 'Snapshot', driver: 'object-tree@1', target: { kind: 'path', path: 'data' },
    access: 'write', isolation: 'fork', source: {}, credentialHandles: [], publish: 'review' }));
  return { store, project, resource, data, engine, service, broker, async close() { (await store.close()); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const sha = (data: Buffer) => crypto.createHash('sha256').update(data).digest('hex');

describe('historical snapshot byte verification', () => {
  it('verifies seven original files after promotion, with bounded evidence and no mutations', async () => {
    const f = (await fixture());
    try {
      const files = [
        { path: 'empty', data: Buffer.alloc(0) }, { path: '日本語/é.txt', data: Buffer.from('Unicode 🌍') },
        { path: 'binary', data: Buffer.from([0, 255, 128, 13, 10]) },
        { path: 'multi', data: Buffer.alloc(6 * 1024 * 1024, 39) },
        { path: 'a', data: Buffer.from('a') }, { path: 'b', data: Buffer.from('b') },
      ];
      files.push({ path: 'padding', data: Buffer.alloc(6297131 - files.reduce((n, file) => n + file.data.length, 0), 71) });
      const old = await f.service.importFiles(f.resource.id, files);
      const head = await f.service.importFiles(f.resource.id, [{ path: 'new', data: Buffer.from('later') }]);
      const before = JSON.stringify((await f.store.listResourceRevisions(f.resource.id)));
      const stored = [...f.data].map(([key, value]) => [key, sha(value)]);
      const result = await f.service.verifyRevision(f.project.id, f.resource.id, old.id);
      expect(result).toMatchObject({ status: 'complete', revisionId: old.id, rootDigest: old.rootDigest,
        manifestVerified: true, totalFiles: 7, totalBytes: 6297131, verifiedBytes: 6297131, storageLocationId: null });
      expect(result.files).toEqual(files.sort((a, b) => a.path.localeCompare(b.path))
        .map((file) => ({ path: file.path, bytes: file.data.length, sha256: sha(file.data) })));
      const page = await f.service.verifyRevision(f.project.id, f.resource.id, old.id, 0, 2);
      expect(page.status).toBe('partial'); expect(page.nextOffset).toBe(2); expect(page.files).toHaveLength(2);
      const last = await f.service.verifyRevision(f.project.id, f.resource.id, old.id, 2, 100);
      expect(last.status).toBe('partial'); expect(last.nextOffset).toBeUndefined();
      expect([...page.files, ...last.files]).toEqual(result.files);
      expect((await f.store.getResourceAttachment(f.resource.id))?.currentRevisionId).toBe(head.id);
      expect(JSON.stringify((await f.store.listResourceRevisions(f.resource.id)))).toBe(before);
      expect((await f.store.listResourceLeases('unused'))).toEqual([]);
      expect([...f.data].map(([key, value]) => [key, sha(value)])).toEqual(stored);
      expect(JSON.stringify(result)).not.toMatch(/sealedRef|objectKey|chunks|resource-store:key|SECRET/);
      for (const args of [[f.project.id, 'wrong', old.id], ['wrong', f.resource.id, old.id], [f.project.id, f.resource.id, 'wrong']])
        await expect(f.service.verifyRevision(args[0]!, args[1]!, args[2]!)).rejects.toThrow('not found');
      await expect(f.service.verifyRevision(f.project.id, f.resource.id, old.id, 0, 1001)).rejects.toThrow('limit');
    } finally { (await f.close()); }
  });

  it('limits large trees and refuses oversized files without reporting them verified', async () => {
    const f = (await fixture());
    try {
      const revision = await f.service.importFiles(f.resource.id,
        Array.from({ length: 1001 }, (_, i) => ({ path: `file-${i}`, data: Buffer.alloc(0) })));
      const page = await f.service.verifyRevision(f.project.id, f.resource.id, revision.id, 0, 1000);
      expect(page).toMatchObject({ status: 'partial', verifiedFiles: 1000, nextOffset: 1000, totalFiles: 1001 });
      async function* largeFile() {
        const chunk = Buffer.alloc(4 * 1024 * 1024, 1);
        for (let i = 0; i < 65; i++) yield chunk;
      }
      const large = await f.service.importFiles(f.resource.id, [{ path: 'large', data: largeFile() }]);
      expect(await f.service.verifyRevision(f.project.id, f.resource.id, large.id)).toMatchObject({
        status: 'partial', issue: 'byte-limit', verifiedFiles: 0, verifiedBytes: 0, nextOffset: 0, files: [],
      });
    } finally { (await f.close()); }
  });

  it('rejects a real revision from another resource or project before reading objects', async () => {
    const f = (await fixture());
    try {
      const revision = await f.service.importFiles(f.resource.id, [{ path: 'a', data: Buffer.from('a') }]);
      const otherProject = (await f.store.createProject('Other'));
      const other = (await f.store.createResourceAttachment({ ...f.resource, id: undefined, projectId: otherProject.id }));
      await expect(f.service.verifyRevision(f.project.id, other.id, revision.id)).rejects.toThrow('not found');
      await expect(f.service.verifyRevision(otherProject.id, other.id, revision.id)).rejects.toThrow('not found');
      await expect(f.service.verifyRevision(otherProject.id, f.resource.id, revision.id)).rejects.toThrow('not found');
    } finally { (await f.close()); }
  });

  it('recomputes the tree digest and file hashes even for authenticated objects', async () => {
    const f = (await fixture());
    try {
      const revision = await f.service.importFiles(f.resource.id, [{ path: 'file', data: Buffer.from('original') }]);
      const manifest = await f.engine.manifest(revision);
      const handle = `resource-store:key:${f.project.organizationId}`;
      const key = Buffer.from(f.broker.resolve(handle, { caps: [`use-credential:${handle}`] }), 'base64');
      // A valid envelope with a stale root digest must fail manifest validation.
      manifest.files[0]!.sha256 = sha(Buffer.from('modified'));
      const ref = JSON.parse(revision.sealedRef);
      const replaceManifest = async () => {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const body = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(manifest))), cipher.final()]);
        const encrypted = Buffer.concat([Buffer.from('KRS1'), iv, cipher.getAuthTag(), body]);
        f.data.set(ref.objectKey, encrypted);
        return { ...revision, rootDigest: manifest.rootDigest, sealedRef: JSON.stringify({ ...ref, sha256: sha(encrypted) }) };
      };
      expect(await f.engine.verify(await replaceManifest(), 0, 100)).toMatchObject({ status: 'failed', manifestVerified: false });
      // With a valid tree digest, plaintext still has to match the individual file hash.
      manifest.rootDigest = sha(Buffer.from(JSON.stringify(manifest.version === 2 ? { packs: manifest.packs, files: manifest.files } : manifest.files)));
      expect(await f.engine.verify(await replaceManifest(), 0, 100)).toMatchObject({
        status: 'failed', manifestVerified: true, verifiedFiles: 0,
      });
    } finally { (await f.close()); }
  });

  it('does not create a replacement encryption key during a failed read', async () => {
    const f = (await fixture());
    try {
      const revision = await f.service.importFiles(f.resource.id, [{ path: 'file', data: Buffer.from('original') }]);
      const handle = `resource-store:key:${f.project.organizationId}`;
      (await f.broker.deleteHandle(handle));
      expect(await f.service.verifyRevision(f.project.id, f.resource.id, revision.id))
        .toMatchObject({ status: 'failed', manifestVerified: false, verifiedFiles: 0 });
      expect(f.broker.hasHandle(handle)).toBe(false);
    } finally { (await f.close()); }
  });

  it.each(['manifest-missing', 'manifest-corrupt', 'chunk-missing', 'chunk-corrupt'])('reports %s without leaking provider errors or claiming byte verification', async (failure) => {
    const f = (await fixture());
    try {
      const revision = await f.service.importFiles(f.resource.id, [{ path: 'file', data: Buffer.from('original') }]);
      const key = [...f.data.keys()].find((key) => key.includes(failure.startsWith('manifest') ? '/manifests/' : '/chunks/'))!;
      if (failure.endsWith('missing')) f.data.delete(key);
      else f.data.set(key, Buffer.from('corrupted'));
      const result = await f.service.verifyRevision(f.project.id, f.resource.id, revision.id);
      expect(result).toMatchObject({ status: 'failed', issue: 'unreadable-or-corrupt', verifiedFiles: 0, files: [] });
      expect(result.manifestVerified).toBe(failure.startsWith('chunk'));
      expect(JSON.stringify(result)).not.toMatch(/SECRET|private|sealedRef|objectKey/);
      expect((await f.store.getResourceAttachment(f.resource.id))?.currentRevisionId).toBe(revision.id);
    } finally { (await f.close()); }
  });
});
