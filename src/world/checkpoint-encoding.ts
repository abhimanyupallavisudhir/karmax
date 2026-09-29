import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

/** `symlink` entries carry the link's exact target as `data` (WD-33). */
export interface DeltaFile { repo: string; path: string; deleted?: boolean; symlink?: boolean; data?: string }
export interface PortableDelta { version: 1; files: DeltaFile[] }

/** Preserve the version-1 wire format while compressing one file at a time.
 * Backpressure bounds uncompressed memory to the current file rather than the
 * whole world's base64 strings plus a second full JSON buffer. ObjectStore still
 * accepts a Buffer, so the compressed result remains in memory. */
export async function encodePortableDelta(files: AsyncIterable<DeltaFile>): Promise<Buffer> {
  async function* json() {
    yield '{"version":1,"files":[';
    let first = true;
    for await (const file of files) {
      yield `${first ? '' : ','}${JSON.stringify(file)}`;
      first = false;
    }
    yield ']}';
  }
  const chunks: Buffer[] = [];
  await pipeline(Readable.from(json()), createGzip(), async source => {
    for await (const chunk of source) chunks.push(Buffer.from(chunk));
  });
  return Buffer.concat(chunks);
}
