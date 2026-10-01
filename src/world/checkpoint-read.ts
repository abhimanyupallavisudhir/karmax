import type { World } from './types.js';

/** What one path is, without following a link. `stamp` changes whenever the
 * file's bytes can have changed; `stable` means it is old enough to trust as
 * "unchanged since" on a later capture (Git's racy-clean rule: a write within
 * the listing's own timestamp tick could reuse the stamp). */
export interface CheckpointStat {
  path: string;
  /** `missing`: gone since Git listed it, which is what restore must reproduce. */
  kind: 'file' | 'link' | 'directory' | 'other' | 'missing';
  bytes: number;
  executable: boolean;
  stamp: string;
  stable: boolean;
}

const STAT = `const fs = require('node:fs');
const now = Date.now();
const result = JSON.parse(process.argv[1]).map(file => {
  let s;
  try { s = fs.lstatSync(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return ['missing', '0', 0, '', 0]; throw error; }
  const kind = s.isSymbolicLink() ? 'link' : s.isFile() ? 'file' : s.isDirectory() ? 'directory' : 'other';
  return [kind, String(s.size), (s.mode & 0o111n) ? 1 : 0, s.size + ':' + s.mtimeNs + ':' + s.ctimeNs + ':' + s.ino,
    Number(s.ctimeNs / 1000000n) < now - 2000 ? 1 : 0];
});
process.stdout.write(JSON.stringify(result));`;

/** Reads exact byte ranges. Each range is checked against the stamp the file
 * was sized with, before and after the read, so a file that changes while it is
 * captured is reported instead of saved torn. Links are never read through (WD-33). */
const READ = `const fs = require('node:fs');
const stamp = s => s.size + ':' + s.mtimeNs + ':' + s.ctimeNs + ':' + s.ino;
const result = JSON.parse(process.argv[1]).map(([file, expected, offset, length]) => {
  let before;
  try { before = fs.lstatSync(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { changed: true }; throw error; }
  if (stamp(before) !== expected) return { changed: true };
  if (before.isSymbolicLink()) return { data: fs.readlinkSync(file, { encoding: 'buffer' }).toString('base64') };
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch (error) { if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) return { changed: true }; throw error; }
  try {
    if (stamp(fs.fstatSync(fd, { bigint: true })) !== expected) return { changed: true };
    const data = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
      const read = fs.readSync(fd, data, done, length - done, offset + done);
      if (!read) return { changed: true };
      done += read;
    }
    if (stamp(fs.fstatSync(fd, { bigint: true })) !== expected) return { changed: true };
    return { data: data.toString('base64') };
  } finally { fs.closeSync(fd); }
});
process.stdout.write(JSON.stringify(result));`;

const BATCH_FILES = 128;
const BATCH_NAMES = 8192;
/** Bytes per read round trip: one sandbox exec returns at most this much (as base64). */
export const READ_BATCH_BYTES = 4 * 1024 * 1024;

/** Paths relative to the world root, one bounded exec per batch. */
export async function statCheckpointFiles(world: World, paths: string[], checkContinue?: () => Promise<void>): Promise<CheckpointStat[]> {
  const out: CheckpointStat[] = [];
  for (let index = 0; index < paths.length;) {
    const batch: string[] = [];
    let names = 0;
    while (index < paths.length && (!batch.length || (batch.length < BATCH_FILES && names + paths[index]!.length <= BATCH_NAMES))) {
      names += paths[index]!.length; batch.push(paths[index++]!);
    }
    await checkContinue?.();
    const result = await world.exec('node', ['-e', STAT, JSON.stringify(batch)], { cwd: world.handle.root });
    if (result.code !== 0) throw new Error(`could not inspect checkpoint files: ${result.stderr.trim().split('\n').pop() ?? ''}`);
    const rows = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(rows) || rows.length !== batch.length) throw new Error('invalid checkpoint file listing');
    rows.forEach((row, i) => {
      const [kind, size, executable, stamp, stable] = row as [CheckpointStat['kind'], string, number, string, number];
      const bytes = Number(size);
      if (!Number.isSafeInteger(bytes) || bytes < 0 || typeof stamp !== 'string') throw new Error('invalid checkpoint file listing');
      out.push({ path: batch[i]!, kind, bytes, executable: executable === 1, stamp, stable: stable === 1 });
    });
  }
  return out;
}

export interface CheckpointRange { path: string; stamp: string; offset: number; length: number }

/** Read ranges in bounded batches, yielding each as its batch arrives, so a
 * consumer holds at most one batch. `data` is undefined for a range whose file
 * changed since it was stat'ed; the caller decides whether to re-stat and retry. */
export async function* readCheckpointRanges<T extends CheckpointRange>(world: World, ranges: T[],
  checkContinue?: () => Promise<void>): AsyncGenerator<{ range: T; data?: Buffer }> {
  for (let index = 0; index < ranges.length;) {
    const batch: T[] = [];
    let bytes = 0, names = 0;
    while (index < ranges.length) {
      const range = ranges[index]!;
      if (batch.length && (batch.length >= BATCH_FILES || bytes + range.length > READ_BATCH_BYTES
        || names + range.path.length > BATCH_NAMES)) break;
      batch.push(range); bytes += range.length; names += range.path.length; index++;
    }
    await checkContinue?.();
    const result = await world.exec('node', ['-e', READ,
      JSON.stringify(batch.map(range => [range.path, range.stamp, range.offset, range.length]))], { cwd: world.handle.root });
    if (result.code !== 0) throw new Error(`checkpoint read failed: ${result.stderr.trim().split('\n').pop() ?? ''}`);
    const rows = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(rows) || rows.length !== batch.length) throw new Error('invalid checkpoint batch');
    for (const [i, row] of (rows as Array<{ changed?: boolean; data?: string }>).entries()) {
      if (row?.changed) { yield { range: batch[i]! }; continue; }
      if (typeof row?.data !== 'string') throw new Error('invalid checkpoint file');
      const data = Buffer.from(row.data, 'base64');
      // A link's length is its target's; a regular range is exactly what was asked for.
      yield { range: batch[i]!, ...(data.length === batch[i]!.length ? { data } : {}) };
    }
  }
}
