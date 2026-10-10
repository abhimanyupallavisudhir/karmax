import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResourceChangeSummary } from '../domain/types.js';
import { ResourceConflictError } from './resource-conflict.js';
import { ROOT_PART, partsTotals, validPartName, type ChangeSet, type Parts, type PartsCapture, type Repository,
  type ResticResources, type ResticRunOptions } from './restic-engine.js';
import type { World } from './types.js';
import { isRemoteWorldKind } from './types.js';

/**
 * On-demand resources (wiki features/resource-storage, planned/compute-disk
 * item 1): a world gets a resource's listing but not its bytes, and its agent
 * fetches the top-level folders it needs with `tavya-data get`.
 *
 * Restic snapshots are whole trees and cannot be grafted, so such a resource's
 * version is a set of parts, one snapshot per top-level entry. A save backs up
 * only the parts the world fetched (or created) and keeps every other part's
 * snapshot as it was: a part the world never fetched, or dropped again, cannot
 * change, let alone be deleted. Only deleting a fetched part's files deletes
 * them. Merges compare parts by snapshot first, so most of a resource is
 * merged by keeping one snapshot id or the other, without touching any bytes.
 */

/** Where a world keeps what `tavya-data` needs, per resource. */
export const DATA_ROOT = '.karmax-injection/data';
export const DATA_TOOL = '.karmax-injection/bin/tavya-data';
const TOOL_SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tavya-data.mjs');

export interface DataManifest {
  version: 1;
  attachmentId: string;
  name: string;
  /** Absolute path of the resource in the world, and as the agent sees it. */
  path: string;
  label: string;
  access: 'read' | 'write';
  /** restic in this world. */
  restic: string;
  parts: Parts;
  /** The repository the parts are in (wiki features/resource-storage). */
  storageLocationId?: string;
}

export interface DataGrant { env: Record<string, string>; expiresAt: number }

export function dataDir(attachmentId: string): string { return `${DATA_ROOT}/${attachmentId}`; }

/** The parts the world holds, as `tavya-data` last recorded them. A world
 * without a record holds none: nothing on its disk is then taken for a part,
 * and nothing it lacks for a deletion. */
export async function readFetched(world: World, attachmentId: string): Promise<Set<string> | undefined> {
  const text = await readOptional(world, `${dataDir(attachmentId)}/fetched.json`);
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text);
    return new Set(Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string' && validPartName(name)) : []);
  } catch { return new Set(); }
}

export async function writeFetched(world: World, attachmentId: string, fetched: Iterable<string>): Promise<void> {
  await writeAtomically(world, `${dataDir(attachmentId)}/fetched.json`, JSON.stringify([...new Set(fetched)].sort()));
}

export async function writeManifest(world: World, manifest: DataManifest): Promise<void> {
  await writeAtomically(world, `${dataDir(manifest.attachmentId)}/manifest.json`, JSON.stringify(manifest));
}

export async function readManifest(world: World, attachmentId: string): Promise<DataManifest | undefined> {
  const text = await readOptional(world, `${dataDir(attachmentId)}/manifest.json`);
  try { return text ? JSON.parse(text) as DataManifest : undefined; } catch { return undefined; }
}

/** The repository grant `tavya-data` fetches with, readable by the world's user only. */
export async function writeGrant(world: World, attachmentId: string, grant: DataGrant): Promise<void> {
  const file = `${dataDir(attachmentId)}/grant.json`;
  await writeAtomically(world, file, JSON.stringify(grant), '600');
}

export async function readGrant(world: World, attachmentId: string): Promise<DataGrant | undefined> {
  const text = await readOptional(world, `${dataDir(attachmentId)}/grant.json`);
  try { return text ? JSON.parse(text) as DataGrant : undefined; } catch { return undefined; }
}

/** Install the `tavya-data` command: a launcher that finds a Node (the
 * world's own, else the one agent turns install) and the script. */
export async function installTool(world: World): Promise<string> {
  const script = `${DATA_TOOL}.mjs`;
  await world.writeFile(script, fs.readFileSync(TOOL_SOURCE, 'utf8'));
  await world.writeFile(DATA_TOOL, `#!/usr/bin/env bash
# tavya-data: fetch and drop parts of on-demand project data (run with --help).
here="$(cd -- "$(dirname -- "\${BASH_SOURCE[0]}")" && pwd)"
node="$(command -v node || true)"
if [ -z "$node" ]; then for candidate in "$here"/../agent/tools/node-*/bin/node "$here"/../*/tools/node-*/bin/node; do
  [ -x "$candidate" ] && { node="$candidate"; break; }; done; fi
[ -n "$node" ] || { echo "tavya-data needs Node.js, which this world lacks" >&2; exit 127; }
exec "$node" "$here/tavya-data.mjs" "$@"
`);
  const made = await world.exec('chmod', ['755', DATA_TOOL], { cwd: world.handle.root });
  if (made.code !== 0) throw new Error(`could not install tavya-data: ${made.stderr.trim()}`);
  return path.posix.join(world.handle.root, DATA_TOOL);
}

/** Remove the grants (and with them the world's ability to read the repositories). */
export async function removeGrants(world: World): Promise<void> {
  await world.exec('bash', ['-c', `rm -f -- ${DATA_ROOT}/*/grant.json`], { cwd: world.handle.root }).catch(() => undefined);
}

/** The top-level entries of a resource's directory in a world. */
export async function topLevel(world: World, directory: string): Promise<{ folders: string[]; loose: string[] }> {
  const folders: string[] = []; const loose: string[] = [];
  if (!isRemoteWorldKind(world.handle.kind)) {
    if (!fs.existsSync(directory)) return { folders, loose };
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) (entry.isDirectory() ? folders : loose).push(entry.name);
  } else {
    const listed = await world.exec('bash', ['-c', 'cd -- "$1" 2>/dev/null || exit 0; find . -mindepth 1 -maxdepth 1 -printf "%y %P\\0"', 'ls', directory],
      { cwd: world.handle.root, timeoutMs: 60_000 });
    if (listed.code !== 0) throw new Error(`could not list ${directory}: ${listed.stderr.trim()}`);
    for (const entry of listed.stdout.split('\0').filter(Boolean)) (entry.startsWith('d ') ? folders : loose).push(entry.slice(2));
  }
  return { folders: folders.sort(), loose: loose.sort() };
}

export interface PartsSave { capture: PartsCapture; fetched: Set<string> }

/**
 * Save a world's copy of an on-demand resource whose version was `base`:
 * each part it holds (fetched, or created here) is backed up on its own and
 * replaces base's when it differs; every other part keeps base's snapshot.
 * A fetched part missing from the disk was deleted by the world. Files
 * written into a part the world never fetched join that part: it is fetched
 * first, around them, so they are not taken for the whole part.
 */
export async function saveParts(restic: ResticResources, place: { world: World; path: string }, repository: Repository,
  base: Parts, fetched: Set<string>, options: ResticRunOptions & { quota: boolean }): Promise<PartsSave> {
  const held = new Set(fetched);
  const disk = await topLevel(place.world, place.path);
  const present = new Set([...disk.folders, ...(disk.loose.length ? [ROOT_PART] : [])]);
  for (const name of present) {
    if (!validPartName(name)) throw new Error(`cannot save a top-level entry named ${JSON.stringify(name)}`);
    if (held.has(name)) continue;
    if (base[name]) {
      await options.checkContinue?.();
      await restic.restore(place, repository, base[name]!.snapshot, { key: `${options.key}:fetch:${name}`, keep: true,
        ...(options.checkContinue ? { checkContinue: options.checkContinue } : {}) });
    }
    held.add(name);
  }
  const parts: Parts = { ...base };
  const fresh: string[] = [];
  let added = 0;
  for (const name of [...held].sort()) {
    await options.checkContinue?.();
    if (!present.has(name)) { delete parts[name]; held.delete(name); continue; }
    const entries = name === ROOT_PART ? disk.loose : [name];
    const prior = base[name];
    const capture = await restic.backup({ world: place.world, path: place.path, entries }, repository,
      { ...options, key: `${options.key}:${name}`, ...(prior ? { parent: prior.snapshot } : {}) });
    if (prior) {
      const changes = await restic.diff(repository, prior.snapshot, capture.snapshot);
      if (changes.added + changes.modified + changes.deleted === 0) { await restic.forget(repository, [capture.snapshot]); continue; }
    }
    parts[name] = { snapshot: capture.snapshot, files: capture.files, bytes: capture.bytes };
    fresh.push(capture.snapshot);
    added += capture.added;
  }
  return { capture: { parts, ...partsTotals(parts), added, fresh }, fetched: held };
}

/** What `to` changes relative to `from` (none: everything is new), part by
 * part; a part whose snapshot is the same is not looked at. */
export async function partChanges(restic: ResticResources, repository: Repository, from: Parts | undefined, to: Parts)
  : Promise<Omit<ResourceChangeSummary, 'attachmentId' | 'baseRevisionId'>> {
  const total = { added: 0, modified: 0, deleted: 0, bytes: 0, changedPaths: [] as string[] };
  for (const name of [...new Set([...Object.keys(from ?? {}), ...Object.keys(to)])].sort()) {
    const before = from?.[name]; const after = to[name];
    if (before?.snapshot === after?.snapshot) continue;
    let change: { added: number; modified: number; deleted: number; bytes: number; changedPaths: string[] };
    if (before && after) change = await restic.diff(repository, before.snapshot, after.snapshot);
    else {
      const files = await restic.files(repository, (after ?? before)!.snapshot);
      const paths = files.map((file) => file.path);
      change = after ? { added: files.length, modified: 0, deleted: 0, bytes: after.bytes, changedPaths: paths.slice(0, 100) }
        : { added: 0, modified: 0, deleted: files.length, bytes: 0, changedPaths: paths.slice(0, 100) };
    }
    total.added += change.added; total.modified += change.modified; total.deleted += change.deleted; total.bytes += change.bytes;
    for (const changed of change.changedPaths) if (total.changedPaths.length < 100) total.changedPaths.push(changed);
  }
  return total;
}

export interface PartsMerge {
  /** The combined version; undefined when the world already held all of it. */
  merged?: PartsCapture;
  /** The parts the world holds after the merge. */
  fetched: Set<string>;
}

/**
 * Bring into a world's copy (saved as `mine`) what changed between `base`
 * and `theirs` (a newer published version, or a sub-task's output), part by
 * part. A part only one side changed is taken whole from that side: a
 * snapshot id, and, if the world holds the part, theirs' changed files
 * restored into it. A part both changed is merged file by file in the world
 * (fetched first if it was not there); a file both changed differently is a
 * conflict, and nothing is touched, unless `keepOwn` keeps this copy's.
 */
export async function mergeParts(restic: ResticResources, place: { world: World; path: string }, repository: Repository,
  base: Parts, theirs: Parts, mine: Parts, fetched: Set<string>,
  options: ResticRunOptions & { quota: boolean; applied?: { added: number; modified: number; deleted: number }; source?: string;
    keepOwn?: boolean; kept?: Set<string>; label: string }): Promise<PartsMerge> {
  const held = new Set(fetched);
  const result: Parts = {};
  const fresh: string[] = [];
  let changed = false;
  const count = (change: ChangeSet) => {
    if (!options.applied) return;
    for (const kind of change.files.values()) options.applied[kind === '+' ? 'added' : kind === 'M' ? 'modified' : 'deleted']++;
  };
  // Conflicts are found in every part before any is touched.
  const plans: Array<{ name: string; theirs: ChangeSet; ours: ChangeSet }> = [];
  const conflicts: string[] = [];
  const names = [...new Set([...Object.keys(base), ...Object.keys(theirs), ...Object.keys(mine)])].sort();
  for (const name of names) {
    const b = base[name]?.snapshot; const t = theirs[name]?.snapshot; const o = mine[name]?.snapshot;
    if (t === b || t === o) { if (mine[name]) result[name] = mine[name]!; continue; }
    if (o === b) continue; // only theirs changed it: below
    const [theirsChange, oursChange] = await Promise.all([partChangeSet(restic, repository, b, t), partChangeSet(restic, repository, b, o)]);
    const both = [...theirsChange.files.keys()].filter((file) => oursChange.files.has(file));
    if (both.length) {
      const differing = (await partChangeSet(restic, repository, t, o)).files;
      for (const file of both.filter((candidate) => differing.has(candidate))) {
        conflicts.push(file);
        options.kept?.add(file);
      }
    }
    plans.push({ name, theirs: theirsChange, ours: oursChange });
  }
  if (conflicts.length && !options.keepOwn) {
    for (const file of conflicts) options.kept?.delete(file);
    throw new ResourceConflictError(options.label, conflicts, options.source);
  }
  for (const name of names) {
    const b = base[name]?.snapshot; const t = theirs[name]?.snapshot; const o = mine[name]?.snapshot;
    if (t === b || t === o || o !== b) continue;
    // Only theirs changed this part: theirs' snapshot, and its files where the world holds the part.
    await options.checkContinue?.();
    const change = await partChangeSet(restic, repository, o, t);
    count(change);
    if (theirs[name]) result[name] = theirs[name]!;
    changed = true;
    if (!held.has(name)) continue;
    if (!t) {
      await removeEntries(place, name === ROOT_PART ? [...change.files.keys()] : [name]);
      held.delete(name);
    } else await applyChange(restic, place, repository, t, change, { ...options, key: `${options.key}:${name}` });
  }
  for (const plan of plans) {
    const { name } = plan;
    const t = theirs[plan.name]?.snapshot; const o = mine[name]?.snapshot;
    await options.checkContinue?.();
    const paths: string[] = []; const deletions: string[] = [];
    for (const [file, kind] of plan.theirs.files) {
      if (plan.ours.files.has(file)) continue;
      (kind === '-' ? deletions : paths).push(file);
    }
    if (!paths.length && !deletions.length) { if (mine[name]) result[name] = mine[name]!; continue; }
    if (options.applied) for (const file of paths) options.applied[plan.theirs.files.get(file) === '+' ? 'added' : 'modified']++;
    if (options.applied) options.applied.deleted += deletions.length;
    // Merged in the world: it needs this copy's version of the part on its disk.
    if (!held.has(name) && o) {
      await restic.restore(place, repository, o, { key: `${options.key}:${name}:fetch`, keep: true,
        ...(options.checkContinue ? { checkContinue: options.checkContinue } : {}) });
    }
    held.add(name);
    if (t) await restic.applyPaths(place, repository, t, { paths, deletions, removedDirectories: plan.theirs.removedDirectories,
      addedDirectories: plan.theirs.addedDirectories, own: plan.ours }, { ...options, key: `${options.key}:${name}:apply` });
    else await removeEntries(place, deletions);
    const disk = await topLevel(place.world, place.path);
    const entries = name === ROOT_PART ? disk.loose : disk.folders.includes(name) ? [name] : [];
    if (!entries.length) { held.delete(name); changed = true; continue; }
    const saved = await restic.backup({ world: place.world, path: place.path, entries }, repository,
      { ...options, key: `${options.key}:${name}:save`, ...(o ? { parent: o } : {}) });
    // Right only if it differs from theirs exactly where this copy's own changes are.
    const stray = [...(await partChangeSet(restic, repository, t, saved.snapshot)).files.keys()].filter((file) => !plan.ours.files.has(file));
    if (stray.length) throw new Error(`${options.label} changed while newer changes were merged into it (${stray.slice(0, 3).join(', ')}); try again`);
    result[name] = { snapshot: saved.snapshot, files: saved.files, bytes: saved.bytes };
    fresh.push(saved.snapshot);
    changed = true;
  }
  return { ...(changed ? { merged: { parts: result, ...partsTotals(result), added: 0, fresh } } : {}), fetched: held };
}

/** What changed from one part's snapshot to another's; none: the part is not there. */
async function partChangeSet(restic: ResticResources, repository: Repository, from: string | undefined, to: string | undefined): Promise<ChangeSet> {
  if (to) return restic.changeSet(repository, from, to);
  const gone = from ? await restic.changeSet(repository, undefined, from) : { files: new Map(), removedDirectories: [], addedDirectories: [] };
  return { files: new Map([...gone.files.keys()].map((file) => [file, '-' as const])), removedDirectories: gone.addedDirectories, addedDirectories: [] };
}

async function applyChange(restic: ResticResources, place: { world: World; path: string }, repository: Repository, snapshot: string,
  change: ChangeSet, options: ResticRunOptions): Promise<void> {
  const paths: string[] = []; const deletions: string[] = [];
  for (const [file, kind] of change.files) (kind === '-' ? deletions : paths).push(file);
  if (!paths.length && !deletions.length) return;
  await restic.applyPaths(place, repository, snapshot, { paths, deletions, removedDirectories: change.removedDirectories,
    addedDirectories: change.addedDirectories }, options);
}

async function removeEntries(place: { world: World; path: string }, entries: string[]): Promise<void> {
  if (!entries.length) return;
  const list = `${DATA_ROOT}/remove-${Date.now().toString(36)}`;
  await place.world.writeFile(list, entries.map((entry) => `${entry}\0`).join(''));
  const removed = await place.world.exec('bash', ['-c', 'set -e; l="$(pwd)/$2"; cd -- "$1"; xargs -0 -r chmod -R u+w -- < "$l" 2>/dev/null || true; xargs -0 -r rm -rf -- < "$l"; rm -f -- "$l"',
    'remove', place.path, list], { cwd: place.world.handle.root, timeoutMs: 10 * 60_000 });
  if (removed.code !== 0) throw new Error(`could not remove files of the resource: ${removed.stderr.trim().slice(0, 300)}`);
}

async function readOptional(world: World, relative: string): Promise<string | undefined> {
  const probe = await world.exec('bash', ['-c', 'test -f "$1" && echo yes || echo no', 'probe', relative], { cwd: world.handle.root });
  if (probe.stdout.trim() !== 'yes') return undefined;
  return world.readFile(relative);
}

async function writeAtomically(world: World, relative: string, content: string, mode?: string): Promise<void> {
  const temporary = `${relative}.${Date.now().toString(36)}.tmp`;
  await world.writeFile(temporary, content);
  const moved = await world.exec('bash', ['-c', `${mode ? `chmod ${mode} -- "$1" && ` : ''}mv -f -- "$1" "$2"`, 'write', temporary, relative],
    { cwd: world.handle.root });
  if (moved.code !== 0) throw new Error(`could not write ${relative}: ${moved.stderr.trim()}`);
}
