import crypto from 'node:crypto';
import type { CredentialBroker } from '../../src/autonomy/broker.js';
import type { ResourceAttachment, ResourceRevision } from '../../src/domain/types.js';
import type { Store } from '../../src/store/db.js';
import type { ObjectStore } from '../../src/store/objects.js';
import { CHUNK_BYTES, chunkId, chunkObjectKey, organizationKey, sealDeterministic, sealRandom, sha256 } from '../../src/world/chunk-store.js';

/**
 * A resource version as the pre-restic engine saved it (manifest version 1:
 * encrypted 4 MiB chunks and a sealed manifest), for tests of reading,
 * restoring and converting the versions already stored. Nothing in tavya
 * writes this format any more.
 */
export async function legacyRevision(store: Store, broker: CredentialBroker, objects: ObjectStore, attachment: ResourceAttachment,
  files: Array<{ path: string; data: Buffer }>, extra: Partial<Pick<ResourceRevision, 'metadata' | 'createdAt' | 'parentRevisionId'
    | 'createdByTaskId' | 'storageLocationId'>> = {}): Promise<ResourceRevision> {
  const organizationId = attachment.organizationId;
  const key = await organizationKey(broker, organizationId);
  const sorted = [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const entries: Array<{ path: string; bytes: number; sha256: string; chunks: string[] }> = [];
  const chunks = new Map<string, number>();
  for (const file of sorted) {
    const ids: string[] = [];
    for (let offset = 0; ; offset += CHUNK_BYTES) {
      const piece = file.data.subarray(offset, offset + CHUNK_BYTES);
      const id = chunkId(key, extra.storageLocationId, piece);
      const sealed = sealDeterministic(key, id, piece);
      await objects.put(chunkObjectKey(organizationId, id), sealed);
      chunks.set(id, sealed.length);
      ids.push(id);
      if (offset + CHUNK_BYTES >= file.data.length) break;
    }
    entries.push({ path: file.path, bytes: file.data.length, sha256: sha256(file.data), chunks: ids });
  }
  await store.retainResourceChunks(organizationId, [...chunks].map(([id, bytes]) => ({ id, bytes })), extra.storageLocationId,
    { enforceQuota: false });
  const bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const rootDigest = sha256(Buffer.from(JSON.stringify(entries)));
  const sealed = sealRandom(key, Buffer.from(JSON.stringify({ version: 1, attachmentId: attachment.id, files: entries, rootDigest, bytes })));
  const objectKey = `resources/${organizationId}/manifests/${attachment.id}/${crypto.randomUUID()}.bin`;
  await objects.put(objectKey, sealed);
  return store.saveResourceRevision({ attachmentId: attachment.id, engine: 'object-snapshot@1',
    sealedRef: JSON.stringify({ objectKey, sha256: sha256(sealed), ...(extra.storageLocationId ? { storageLocationId: extra.storageLocationId } : {}) }),
    rootDigest, bytes, files: entries.length, metadata: extra.metadata ?? {}, ...extra });
}
