import fs from 'node:fs';
import type { World } from './types.js';

/** At most `maxBytes` from the start of a regular host file. Opened
 * non-blocking so a FIFO cannot hold a thread-pool thread waiting for a
 * writer; anything but a regular file is refused. */
export async function readRegularFilePrefix(file: string, maxBytes: number): Promise<Buffer> {
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  try {
    if (!(await handle.stat()).isFile()) throw new Error('not a regular file');
    const chunks: Buffer[] = [];
    let length = 0;
    while (length < maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, maxBytes - length));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, length);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead));
      length += bytesRead;
    }
    return Buffer.concat(chunks, length);
  } finally {
    await handle.close();
  }
}

/** At most `maxBytes` from the start of a world file, through the provider's
 * bounded read, so a huge or endless sandbox file never reaches this process
 * whole. A world without one (a test double) is read whole. */
export async function readWorldFilePrefix(world: World, relPath: string, maxBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('invalid read limit');
  if (world.readFilePrefix) return world.readFilePrefix(relPath, maxBytes);
  return (await world.readFileBuffer(relPath)).subarray(0, maxBytes);
}
