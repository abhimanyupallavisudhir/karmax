import type { World } from './types.js';

const READ = `const fs = require('node:fs');
const files = JSON.parse(process.argv[1]);
const result = files.map(([file, size]) => {
  const fd = fs.openSync(file, 'r');
  try {
    if (fs.fstatSync(fd).size !== size) throw Error('checkpoint file changed');
    const data = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const read = fs.readSync(fd, data, offset, size - offset, offset);
      if (!read) throw Error('checkpoint file truncated');
      offset += read;
    }
    if (fs.fstatSync(fd).size !== size) throw Error('checkpoint file changed');
    return data.toString('base64');
  } finally { fs.closeSync(fd); }
});
process.stdout.write(JSON.stringify(result));`;

/** A bounded batch uses one sandbox/lease round trip. Sizes are checked again
 * inside the sandbox, and no file API can buffer an unexpectedly growing file. */
export async function* readCheckpointFiles(world: World, sizes: Map<string, number>,
  checkContinue?: () => Promise<void>): AsyncGenerator<{ path: string; data: Buffer }> {
  const entries = [...sizes];
  for (let index = 0; index < entries.length;) {
    const batch: Array<[string, number]> = [];
    let bytes = 0, names = 0;
    while (index < entries.length) {
      const entry = entries[index]!;
      if (batch.length && (batch.length >= 128 || bytes + entry[1] > 4 * 1024 * 1024 || names + entry[0].length > 8192)) break;
      batch.push(entry); bytes += entry[1]; names += entry[0].length; index++;
    }
    await checkContinue?.();
    const result = await world.exec('node', ['-e', READ, JSON.stringify(batch)], { cwd: world.handle.root });
    if (result.code !== 0) throw new Error(`checkpoint read failed: ${result.stderr}`);
    const data = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(data) || data.length !== batch.length) throw new Error('invalid checkpoint batch');
    for (let i = 0; i < batch.length; i++) {
      if (typeof data[i] !== 'string') throw new Error('invalid checkpoint file');
      const buffer = Buffer.from(data[i], 'base64');
      if (buffer.length !== batch[i]![1]) throw new Error('checkpoint file changed during capture');
      yield { path: batch[i]![0], data: buffer };
    }
  }
}
