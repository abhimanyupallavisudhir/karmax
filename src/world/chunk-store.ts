import crypto from 'node:crypto';
import { gunzip, gzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { CredentialBroker } from '../autonomy/broker.js';
import { organizationScope } from '../autonomy/vault-keys.js';

/** Encrypted content-addressed chunks shared by project-resource snapshots and
 * world checkpoints. One organization key, one chunk namespace and one
 * reference count (`resource_snapshot_chunks`), so the same bytes are stored
 * once per storage location however many revisions and checkpoints hold them. */
export const CHUNK_BYTES = 4 * 1024 * 1024;
const KEY_PREFIX = 'resource-store:key:';
const deflate = promisify(gzip);
const inflate = promisify(gunzip);

export function organizationKeyHandle(organizationId: string): string { return `${KEY_PREFIX}${organizationId}`; }

export async function organizationKey(broker: CredentialBroker, organizationId: string, create = true): Promise<Buffer> {
  const handle = organizationKeyHandle(organizationId);
  if (!broker.hasHandle(handle)) {
    if (!create) throw new Error('resource key unavailable');
    await broker.ensureHandle(handle, crypto.randomBytes(32).toString('base64'), organizationScope(organizationId));
  }
  return Buffer.from(broker.resolve(handle, { caps: [`use-credential:${handle}`] }), 'base64');
}

export function chunkObjectKey(organizationId: string, chunkId: string): string {
  return `resources/${organizationId}/chunks/${chunkId}.bin`;
}

/** HMAC-scoped names deduplicate within a tenant without leaking a global
 * plaintext hash to the object-store operator. Customer locations join the
 * namespace so the same chunk can safely live in two buckets. `kind` separates
 * encodings that must never share a name (a pack is not a raw file chunk). */
export function chunkId(key: Buffer, namespace: string | undefined, plain: Buffer, kind?: 'pack'): string {
  const hash = sha256(plain);
  const scoped = namespace ? `${namespace}\0${hash}` : hash;
  return crypto.createHmac('sha256', key).update(kind ? `${kind}\0${scoped}` : scoped).digest('hex');
}

export async function* fixedChunks(value: Buffer | AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  const source = Buffer.isBuffer(value) ? (async function* () { yield value; })() : value;
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let emitted = false;
  for await (const raw of source) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= CHUNK_BYTES) {
      emitted = true;
      yield pending.subarray(0, CHUNK_BYTES);
      pending = pending.subarray(CHUNK_BYTES);
    }
  }
  if (pending.length || !emitted) yield pending;
}

export function sealRandom(key: Buffer, plain: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from('KRS1'), iv, cipher.getAuthTag(), body]);
}

export function openRandom(key: Buffer, blob: Buffer): Buffer {
  if (blob.subarray(0, 4).toString() !== 'KRS1') throw new Error('invalid resource snapshot envelope');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(4, 16));
  decipher.setAuthTag(blob.subarray(16, 32));
  return Buffer.concat([decipher.update(blob.subarray(32)), decipher.final()]);
}

/** A raw file chunk: identical bytes always produce the identical object. */
export function sealDeterministic(key: Buffer, id: string, plain: Buffer): Buffer {
  const iv = crypto.createHmac('sha256', key).update(`iv:${id}`).digest().subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(id));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from('KRC1'), cipher.getAuthTag(), body]);
}

export function openDeterministic(key: Buffer, id: string, blob: Buffer): Buffer {
  if (blob.subarray(0, 4).toString() !== 'KRC1') throw new Error('invalid resource chunk envelope');
  const iv = crypto.createHmac('sha256', key).update(`iv:${id}`).digest().subarray(0, 12);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(id));
  decipher.setAuthTag(blob.subarray(4, 20));
  return Buffer.concat([decipher.update(blob.subarray(20)), decipher.final()]);
}

/** A compressed chunk. Compressor output can differ between zlib versions for
 * the same id, so its nonce is random, never derived from the id. */
export async function sealCompressed(key: Buffer, id: string, plain: Buffer): Promise<Buffer> {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(id));
  const body = Buffer.concat([cipher.update(await deflate(plain)), cipher.final()]);
  return Buffer.concat([Buffer.from('KRZ1'), iv, cipher.getAuthTag(), body]);
}

export async function openCompressed(key: Buffer, id: string, blob: Buffer, maxBytes: number): Promise<Buffer> {
  if (blob.subarray(0, 4).toString() !== 'KRZ1') throw new Error('invalid compressed chunk envelope');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(4, 16));
  decipher.setAAD(Buffer.from(id));
  decipher.setAuthTag(blob.subarray(16, 32));
  return inflate(Buffer.concat([decipher.update(blob.subarray(32)), decipher.final()]), { maxOutputLength: maxBytes });
}

export function sha256(value: Buffer): string { return crypto.createHash('sha256').update(value).digest('hex'); }
