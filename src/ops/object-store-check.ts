import crypto from 'node:crypto';
import path from 'node:path';
import { objectDeleteDelayMs } from '../store/deferred-delete.js';
import { S3ObjectStore, managedS3Options } from '../store/objects.js';

/**
 * Which managed object store this installation uses, and for S3 whether it
 * answers: the same write, read-back and delete probe a customer bucket must
 * pass before use (`StorageLocationService.test`). `deploy/karmax doctor`.
 */
export async function checkObjectStore(env: NodeJS.ProcessEnv = process.env,
  fetcher?: typeof fetch): Promise<{ ok: boolean; lines: string[] }> {
  let delay: string;
  try {
    const days = objectDeleteDelayMs(env) / (24 * 60 * 60_000);
    delay = days ? `deletes after ${days} day${days === 1 ? '' : 's'}` : 'deletes immediately';
  } catch (error) { return { ok: false, lines: [(error as Error).message] }; }
  if (env.KARMAX_OBJECT_STORE !== 's3') {
    const home = env.KARMAX_HOME?.trim() || path.join(process.env.HOME ?? '', '.karmax');
    return { ok: true, lines: [`object store: local, ${path.join(home, 'objects')}; ${delay}`] };
  }
  let options;
  try { options = managedS3Options(env); }
  catch (error) { return { ok: false, lines: ['object store: s3', `not configured: ${(error as Error).message}`] }; }
  const lines = [`object store: s3, bucket ${options.bucket} at ${options.endpoint} (region ${options.region}); ${delay}`];
  const objects = new S3ObjectStore({ ...options, ...(fetcher ? { fetch: fetcher } : {}) });
  const key = `.karmax-connection-test/${crypto.randomBytes(12).toString('hex')}`;
  const expected = Buffer.from('karmax object store probe');
  try {
    await objects.put(key, expected, 'text/plain');
    try {
      if (!(await objects.get(key)).equals(expected)) throw new Error('read-back did not match the probe object');
    } finally {
      await objects.delete(key, { timeoutMs: 15_000 });
    }
    lines.push('probe: PUT, GET and DELETE succeeded');
    return { ok: true, lines };
  } catch (error) {
    lines.push(`probe failed: ${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, lines };
  }
}
