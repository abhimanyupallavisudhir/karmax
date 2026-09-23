import crypto from 'node:crypto';
import path from 'node:path';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { World } from './types.js';
import { timed } from '../timing/index.js';

const compress = promisify(gzip);
const quote = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`;

/** Transfer one ordered chunk. Compression is enabled only after a world-local
 * gzip probe, and only when it saves enough bytes to justify remote decoding. */
export async function transferResourceChunk(world: World, target: string, data: Buffer, offset: number,
  options: { compress?: boolean; signal?: AbortSignal } = {}): Promise<number> {
  options.signal?.throwIfAborted();
  let encoded = data;
  let compressed = false;
  if (options.compress && world.writeFileBuffer && data.length >= 256 * 1024) {
    const candidate = await timed('resource.compress', () => compress(data, { level: 1 }));
    if (candidate.length < data.length * .75) { encoded = candidate; compressed = true; }
  }
  options.signal?.throwIfAborted();
  if (!compressed && offset === 0) {
    if (world.writeFileBuffer) await world.writeFileBuffer(target, data);
    else await world.writeFile(target, data.toString('utf8'));
    return data.length;
  }
  const temporary = `.karmax-injection/resource-chunk-${crypto.randomBytes(8).toString('hex')}`;
  if (world.writeFileBuffer) await world.writeFileBuffer(temporary, encoded);
  else await world.writeFile(temporary, encoded.toString('base64'));
  options.signal?.throwIfAborted();
  const decoder = compressed ? 'gzip -dc' : world.writeFileBuffer ? 'cat' : 'base64 -d';
  const command = `mkdir -p ${quote(path.posix.dirname(target))} && ${decoder} ${quote(temporary)} ${offset === 0 ? '>' : '>>'} ${quote(target)}; status=$?; rm -f ${quote(temporary)}; exit "$status"`;
  const result = await world.exec('bash', ['-lc', command], { cwd: world.handle.root });
  if (result.code !== 0) throw new Error(result.stderr || 'Could not restore resource chunk');
  return encoded.length;
}
