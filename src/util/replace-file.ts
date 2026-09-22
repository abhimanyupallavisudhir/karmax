import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Publish a complete small config file to concurrent readers. This does not
 * serialize multiple writers or promise power-loss durability. The primary
 * process owns managed config edits; provider-owned auth files are separate.
 * Preserve symlinks (including dangling links) and existing permission bits.
 */
export function replaceFileSync(filename: string, contents: string): void {
  let target = path.resolve(filename);
  let mode = 0o600;
  for (let depth = 0; ; depth++) {
    if (depth >= 40) throw new Error('too many config file symlinks');
    let stat: fs.Stats;
    try { stat = fs.lstatSync(target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
    if (!stat.isSymbolicLink()) {
      if (!stat.isFile()) throw new Error('config target is not a regular file');
      mode = stat.mode & 0o777;
      break;
    }
    target = path.resolve(path.dirname(target), fs.readlinkSync(target));
  }
  const temporary = path.join(path.dirname(target), `.karmax-config-${crypto.randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, contents);
    fs.fchmodSync(descriptor, mode);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, target);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}
