import crypto from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { encodeEncryptedCheckpoint, checkpointEncodingStats, type CheckpointFile } from '../src/world/checkpoint-executor.js';

function restore(encrypted: Buffer, key: Buffer) {
  expect(encrypted.subarray(0, 4).toString()).toBe('KMX1');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, encrypted.subarray(4, 16));
  decipher.setAuthTag(encrypted.subarray(16, 32));
  return JSON.parse(gunzipSync(Buffer.concat([decipher.update(encrypted.subarray(32)), decipher.final()])).toString());
}

it('preserves the old encrypted envelope and JSON format across base64 chunk boundaries', async () => {
  const key = crypto.randomBytes(32);
  const files: CheckpointFile[] = [
    { repo: 'main', path: 'escaped"\nname', data: crypto.randomBytes(48 * 1024 + 7) },
    { repo: 'other', path: 'deleted', deleted: true },
    { repo: '', path: 'empty', data: Buffer.alloc(0) },
  ];
  async function* input() { yield* files; }
  const result = await encodeEncryptedCheckpoint(input(), key);
  expect(result.sha256).toBe(crypto.createHash('sha256').update(result.encrypted).digest('hex'));
  expect(restore(result.encrypted, key)).toEqual({ version: 1,
    files: files.map(({ data, ...rest }) => ({ ...rest, ...(data ? { data: data.toString('base64') } : {}) })) });
  async function* empty() {}
  expect(restore((await encodeEncryptedCheckpoint(empty(), key)).encrypted, key)).toEqual({ version: 1, files: [] });
  expect(checkpointEncodingStats()).toEqual({ active: 0, waiting: 0 });
});

it('bounds concurrent encoders and consumes no queued file contents before admission', async () => {
  const key = crypto.randomBytes(32);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  async function* first() { entered(); await gate; yield { repo: '', path: 'a', data: Buffer.from('a') }; }
  let secondConsumed = false;
  async function* second() { secondConsumed = true; yield { repo: '', path: 'b', data: Buffer.from('b') }; }
  const one = encodeEncryptedCheckpoint(first(), key);
  await started;
  const two = encodeEncryptedCheckpoint(second(), key);
  expect(checkpointEncodingStats()).toEqual({ active: 1, waiting: 1 });
  expect(secondConsumed).toBe(false);
  release();
  const results = await Promise.all([one, two]);
  expect(results.map(result => restore(result.encrypted, key).files[0].path)).toEqual(['a', 'b']);
  expect(checkpointEncodingStats()).toEqual({ active: 0, waiting: 0 });
});

it('releases admission after source and worker failures', async () => {
  async function* badSource() { throw Error('provider file read failed'); }
  await expect(encodeEncryptedCheckpoint(badSource(), crypto.randomBytes(32))).rejects.toThrow('provider file read failed');
  async function* empty() {}
  await expect(encodeEncryptedCheckpoint(empty(), Buffer.alloc(1))).rejects.toThrow();
  expect(checkpointEncodingStats()).toEqual({ active: 0, waiting: 0 });
  const key = crypto.randomBytes(32);
  expect(restore((await encodeEncryptedCheckpoint(empty(), key)).encrypted, key).files).toEqual([]);
});

it('rejects excess queued encoders without consuming their input or leaking capacity', async () => {
  const key = crypto.randomBytes(32);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  async function* blocked() { entered(); await gate; }
  async function* empty() {}
  const active = encodeEncryptedCheckpoint(blocked(), key);
  await started;
  const queued = Array.from({ length: 16 }, () => encodeEncryptedCheckpoint(empty(), key));
  const completed = Promise.all([active, ...queued]);
  let consumed = false;
  async function* excess() { consumed = true; }
  try {
    await expect(encodeEncryptedCheckpoint(excess(), key)).rejects.toThrow('capacity exceeded');
    expect(consumed).toBe(false);
    expect(checkpointEncodingStats()).toEqual({ active: 1, waiting: 16 });
  } finally { release(); await completed; }
  expect(checkpointEncodingStats()).toEqual({ active: 0, waiting: 0 });
});
