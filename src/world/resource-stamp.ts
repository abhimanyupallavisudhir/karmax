/**
 * A cheap fingerprint of a writable resource's copy in a world, so a copy
 * nobody touched is not saved again at every park, Review and Confirm.
 *
 * Saving an unchanged copy costs little upload (restic deduplicates) but a
 * restic run in the world each time: a job, its repository opened through the
 * edge, a scan of every file, a dry run to see the files settled, a diff on
 * the server. About 10 s per resource on E2B, and every task of a project with
 * a writable resource paid it at Confirm and at every park, and every look at
 * Review paid it again.
 *
 * The stamp is the SHA-256 of every entry's type, mode, size, modification
 * and status-change times (nanoseconds) and link target, in one `find` in the
 * world. It is taken when the copy's content is known (just restored, or just
 * before a save whose result is recorded) and kept with the version that
 * content is (kv `resource-stamp:<task>:<lease>`). A copy whose stamp still
 * matches is that version.
 *
 * Stricter than restic's own change detection (`--ignore-inode`: size and
 * modification time): the status-change time moves on every write, chmod,
 * rename or link and cannot be set back, so an edit that restores the old
 * modification time is still seen. Anything the stamp cannot vouch for (no
 * GNU find, a copy that is gone, a world restored some other way) falls back
 * to a save, as before.
 */
import type { World } from './types.js';

export interface CopyStamp { revisionId: string; digest: string }

export function stampKey(taskId: string, leaseId: string): string { return `resource-stamp:${taskId}:${leaseId}`; }

/** The script that prints a copy's stamp, or fails. */
export function stampScript(target: string, file: boolean): string {
  const at = quote(target);
  // A single-file resource that is a symlink is saved as its target.
  return file
    ? `set -o pipefail; t=$(readlink -e -- ${at}) && { printf '%s\\n' "$t"; find -L ${at} -maxdepth 0 -printf '%y %m %U %G %s %T@ %C@\\n'; } | sha256sum`
    : `set -o pipefail; cd -- ${at} && find . -printf '%y %m %U %G %s %T@ %C@ %l %P\\0' | LC_ALL=C sort -z | sha256sum`;
}

/** A copy's stamp, or undefined when it cannot be taken (then nothing is assumed). */
export async function stampCopy(world: World, target: string, file: boolean): Promise<string | undefined> {
  if (!target || target === '/' || target === world.handle.root) return undefined; // the world's whole root: never cheap
  try {
    const result = await world.exec('bash', ['-c', stampScript(target, file)], { cwd: world.handle.root });
    const digest = /^([0-9a-f]{64})\b/.exec(result.stdout.trim())?.[1];
    return result.code === 0 ? digest : undefined;
  } catch { return undefined; }
}

export function parseStamp(value: string | undefined): CopyStamp | undefined {
  try {
    const parsed = value ? JSON.parse(value) as Partial<CopyStamp> : undefined;
    return parsed && typeof parsed.revisionId === 'string' && typeof parsed.digest === 'string'
      ? { revisionId: parsed.revisionId, digest: parsed.digest } : undefined;
  } catch { return undefined; }
}

function quote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
