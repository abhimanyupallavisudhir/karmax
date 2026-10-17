import path from 'node:path';
import { ResourceConflictError } from './resource-conflict.js';
import type { Repository, ResticPlace, ResticResources, ResticRunOptions } from './restic-engine.js';
import type { World } from './types.js';

// Files both a task and the version merged into its copy (a newer published
// one, or a sub-task's) changed differently (pramana#56, 2026-10-16). Each is
// first merged line by line in the world, as git merges a file; what does not
// merge goes to the task's agent, in a folder beside the resource
// (`MERGE_ROOT/<attachment>`):
//   base/<file>       the file as both started from
//   other/<file>      the incoming version
//   conflicts/<file>  a line merge with conflict markers (text only)
//   unresolved        the files left to combine, one per line
//   conflict.json     which incoming version these are for
//   fetch             fetches the copies the disk had no room for
// The agent makes its copy of each file what it should be and removes the
// file's line from `unresolved`; the next merge with the same incoming
// version then keeps its copy of that file as it is.

export type ConflictKind = 'edited' | 'added' | 'deleted here' | 'deleted there';

/** Files that conflict, with the snapshots they are in: the version both
 * started from (none: an empty one), the incoming one and this copy's.
 * An on-demand resource has one group per part. */
export interface ConflictGroup {
  base?: string;
  theirs?: string;
  mine?: string;
  files: Array<{ path: string; kind: ConflictKind }>;
}

export interface FileMergeOptions extends ResticRunOptions {
  label: string;
  /** Who made the incoming changes, for the messages. */
  source?: string;
  /** The incoming version: a resolution recorded for another is not used. */
  theirsId?: string;
}

export interface FileMerge {
  /** File → its merged content, in the world (relative to its root). */
  merged: Map<string, string>;
  /** Files the agent combined: this copy's version is kept. */
  resolved: Set<string>;
}

export const MERGE_ROOT = '.karmax-injection/resource-merge';
/** Larger files are not merged line by line: three copies are held in memory. */
export const LINE_MERGE_MAX_BYTES = 64 * 1024 * 1024;
/** Left free when copies are placed for the agent. */
const DISK_MARGIN_BYTES = 1024 * 1024 * 1024;

export function mergeDirectory(attachmentId: string): string { return `${MERGE_ROOT}/${attachmentId}`; }

/** How a file both sides changed was changed, from each side's change (`+`, `M`, `-`). */
export function conflictKind(theirs: string | undefined, ours: string | undefined): ConflictKind {
  if (ours === '-') return 'deleted here';
  if (theirs === '-') return 'deleted there';
  return ours === '+' && theirs === '+' ? 'added' : 'edited';
}

/** Merge each conflicting file line by line in the world, as git does, and
 * combine lines both sides only appended (the published ones first). Throws
 * a {@link ResourceConflictError} naming what is left for the agent, whose
 * `guide` says how; nothing in the resource is touched. */
export async function mergeFiles(restic: ResticResources, place: ResticPlace, repository: Repository, groups: ConflictGroup[],
  options: FileMergeOptions): Promise<FileMerge> {
  const world = place.world;
  const directory = mergeDirectory(repository.attachment.id);
  const absolute = path.posix.join(world.handle.root, directory);
  const resolved = await readResolved(world, directory, options.theirsId);
  const open = groups.map((group) => ({ ...group, files: group.files.filter((file) => !resolved.has(file.path)) }))
    .filter((group) => group.files.length);
  const merged = new Map<string, string>();
  if (!open.length) return { merged, resolved };
  const odd = open.flatMap((group) => group.files).find((file) => /[\n\r\0]/.test(file.path));
  if (odd) throw new Error(`cannot merge a file named ${JSON.stringify(odd.path)}`);

  // What fits on the disk: line merges need all three copies, the agent two.
  let room = Math.max(0, (await freeBytes(world, world.handle.root)) - DISK_MARGIN_BYTES);
  const plans: Array<ConflictGroup & { placed: Set<string>; mergeable: Set<string>; bytes: Map<string, number> }> = [];
  for (const group of open) {
    const paths = group.files.map((file) => file.path);
    const [base, theirs, mine] = await Promise.all([group.base, group.theirs, group.mine]
      .map((snapshot) => snapshot ? restic.sizes(repository, snapshot, paths) : Promise.resolve(new Map<string, number>())));
    const placed = new Set<string>(); const mergeable = new Set<string>(); const bytes = new Map<string, number>();
    const costs = group.files.map((file) => {
      const both = file.kind === 'edited' || file.kind === 'added';
      const largest = Math.max(base!.get(file.path) ?? 0, theirs!.get(file.path) ?? 0, mine!.get(file.path) ?? 0);
      const lines = both && largest <= LINE_MERGE_MAX_BYTES;
      bytes.set(file.path, largest);
      return { file, lines, cost: (base!.get(file.path) ?? 0) + (theirs!.get(file.path) ?? 0) + (lines ? mine!.get(file.path) ?? 0 : 0) };
    }).sort((a, b) => a.cost - b.cost);
    for (const { file, lines, cost } of costs) {
      if (cost > room) continue;
      room -= cost;
      placed.add(file.path);
      if (lines) mergeable.add(file.path);
    }
    plans.push({ ...group, placed, mergeable, bytes });
  }

  await world.exec('bash', ['-c', 'rm -rf -- "$1" && mkdir -p -- "$1/.work"', 'merge', absolute], { cwd: world.handle.root });
  for (const [index, plan] of plans.entries()) {
    await options.checkContinue?.();
    const key = `${options.key}:files:${index}`;
    const placed = [...plan.placed];
    const kinds = new Map(plan.files.map((file) => [file.path, file.kind]));
    if (plan.base) await restic.restoreFiles(world, repository, plan.base, placed.filter((file) => kinds.get(file) !== 'added'),
      `${absolute}/base`, { ...options, key: `${key}:base` });
    if (plan.theirs) await restic.restoreFiles(world, repository, plan.theirs, placed.filter((file) => kinds.get(file) !== 'deleted there'),
      `${absolute}/other`, { ...options, key: `${key}:theirs` });
    if (plan.mine) await restic.restoreFiles(world, repository, plan.mine, [...plan.mergeable], `${absolute}/.work/mine`,
      { ...options, key: `${key}:mine` });
  }
  const mergeable = plans.flatMap((plan) => [...plan.mergeable]);
  if (mergeable.length) {
    await world.writeFile(`${directory}/.work/list`, mergeable.map((file) => `${file}\0`).join(''));
    const run = await world.exec('bash', ['-c', MERGE_SCRIPT, 'merge', absolute, options.source === 'a sub-task' ? 'sub-task' : 'published'],
      { cwd: world.handle.root, timeoutMs: 30 * 60_000 });
    if (run.code !== 0) throw new Error(`merging files of ${options.label} failed: ${(run.stderr || run.stdout).trim().slice(0, 300)}`);
    for (const record of run.stdout.split('\0')) {
      const tab = record.indexOf('\t');
      if (tab > 0 && record.slice(0, tab) === 'merged') merged.set(record.slice(tab + 1), `${directory}/.work/merged/${record.slice(tab + 1)}`);
    }
  }
  const left = plans.flatMap((plan) => plan.files.filter((file) => !merged.has(file.path))
    .map((file) => ({ ...file, placed: plan.placed.has(file.path), bytes: plan.bytes.get(file.path) ?? 0,
      lines: plan.mergeable.has(file.path) })));
  if (!left.length) return { merged, resolved };

  // For the agent: the copies, what is left and the version it is for.
  await world.exec('rm', ['-rf', '--', `${absolute}/.work`], { cwd: world.handle.root });
  await world.writeFile(`${directory}/unresolved`, left.map((file) => `${file.path}\n`).join(''));
  await world.writeFile(`${directory}/conflict.json`, `${JSON.stringify({ theirs: options.theirsId ?? null,
    files: left.map(({ path: file, kind }) => ({ path: file, kind })) })}\n`);
  const unplaced = plans.map((plan) => ({ ...plan, files: plan.files.filter((file) => !merged.has(file.path) && !plan.placed.has(file.path)) }))
    .filter((plan) => plan.files.length);
  if (unplaced.length) await writeFetch(restic, world, repository, absolute, unplaced);
  const where = place.file ? place.path : place.path.replace(/\/+$/, '');
  throw new ResourceConflictError(options.label, left.map((file) => file.path), options.source,
    guide(options.label, options.source ?? 'a newer published version', where, absolute, left, !!place.file));
}

/** Put merged files into the resource, in place of this copy's. */
export async function applyMerged(place: ResticPlace, merge: FileMerge): Promise<void> {
  if (!merge.merged.size) return;
  const world = place.world;
  const pairs = [...merge.merged].map(([file, source]) =>
    `${path.posix.join(world.handle.root, source)}\0${place.file ? place.path : path.posix.join(place.path, file)}\0`).join('');
  const list = `${MERGE_ROOT}/.apply-${Date.now().toString(36)}`;
  await world.writeFile(list, pairs);
  try {
    // cat keeps the file's mode, and gives it a new mtime: the next save reads it.
    const run = await world.exec('bash', ['-c', 'set -e; while IFS= read -r -d "" s && IFS= read -r -d "" d; do mkdir -p -- "$(dirname -- "$d")"; cat -- "$s" > "$d"; done < "$1"',
      'apply', list], { cwd: world.handle.root, timeoutMs: 10 * 60_000 });
    if (run.code !== 0) throw new Error(`could not write merged files: ${(run.stderr || run.stdout).trim().slice(0, 300)}`);
  } finally {
    await world.exec('rm', ['-f', '--', list], { cwd: world.handle.root }).catch(() => undefined);
  }
}

/** Remove what a merge left for the agent, once nothing conflicts. */
export async function clearMerge(world: World, attachmentId: string): Promise<void> {
  await world.exec('rm', ['-rf', '--', mergeDirectory(attachmentId)], { cwd: world.handle.root }).catch(() => undefined);
}

/** The files the agent has combined for the incoming version `theirsId`:
 * named by the last conflict, no longer in `unresolved`. */
async function readResolved(world: World, directory: string, theirsId: string | undefined): Promise<Set<string>> {
  const read = await world.exec('bash', ['-c', 'cd -- "$1" 2>/dev/null || exit 0; [ -f conflict.json ] && cat conflict.json; printf "\\0"; [ -f unresolved ] && cat unresolved',
    'read', directory], { cwd: world.handle.root });
  const [record = '', unresolved = ''] = read.stdout.split('\0');
  try {
    const conflict = JSON.parse(record) as { theirs?: string | null; files?: Array<{ path?: unknown }> };
    if ((conflict.theirs ?? undefined) !== theirsId) return new Set();
    const left = new Set(unresolved.split('\n').map((line) => line.replace(/\r$/, '')).filter(Boolean));
    return new Set((conflict.files ?? []).map((file) => String(file.path)).filter((file) => !left.has(file)));
  } catch { return new Set(); }
}

async function freeBytes(world: World, directory: string): Promise<number> {
  const df = await world.exec('bash', ['-c', 'df -Pk -- "$1" | awk \'NR==2 { print $4 }\'', 'df', directory], { cwd: world.handle.root });
  const kib = Number(df.stdout.trim());
  return Number.isFinite(kib) && df.code === 0 ? kib * 1024 : 0;
}

/** A script fetching the copies the disk had no room for, with a read grant. */
async function writeFetch(restic: ResticResources, world: World, repository: Repository, absolute: string,
  groups: Array<ConflictGroup>): Promise<void> {
  const reader = await restic.worldReader(world, repository);
  const exports = Object.entries(reader.env).map(([name, value]) => `export ${name}=${shellQuote(value)}`).join('\n');
  const lines: string[] = [];
  const pattern = (files: string[]) => files.map((file) => `/${file.replace(/[\\*?[]/g, (c) => `\\${c}`).replace(/\$/g, '$$$$').replace(/\s/g, (c) => `[${c}]`)}`).join('\n');
  const restore = (snapshot: string, files: string[], into: string, name: string) => {
    // A thousand patterns per run: restic tests every node against every pattern.
    for (let i = 0; i < files.length; i += 1_000) {
      lines.push(`printf '%s\\n' ${shellQuote(pattern(files.slice(i, i + 1_000)))} > "$d/.fetch-${name}-${i}"`,
        `"$r" restore ${snapshot} --target "$d/${into}" --include-file "$d/.fetch-${name}-${i}" --no-lock`);
    }
  };
  for (const [index, group] of groups.entries()) {
    const base = group.files.filter((file) => file.kind !== 'added').map((file) => file.path);
    const theirs = group.files.filter((file) => file.kind !== 'deleted there').map((file) => file.path);
    if (group.base && base.length) restore(group.base, base, 'base', `${index}-base`);
    if (group.theirs && theirs.length) restore(group.theirs, theirs, 'other', `${index}-other`);
  }
  await world.writeFile(`${path.posix.relative(world.handle.root, absolute)}/fetch`,
    `#!/usr/bin/env bash\n# Fetches the copies of files the disk had no room for (a read grant, valid 24 h).\nset -euo pipefail\n${exports}\nr=${shellQuote(reader.binary)}\nd=${shellQuote(absolute)}\n${lines.join('\n')}\nrm -f "$d"/.fetch-*\n`);
  await world.exec('chmod', ['700', '--', `${absolute}/fetch`], { cwd: world.handle.root });
}

function guide(label: string, source: string, where: string, directory: string,
  files: Array<{ path: string; kind: ConflictKind; placed: boolean; bytes: number; lines: boolean }>, single: boolean): string {
  const what: Record<ConflictKind, string> = {
    edited: 'both edited it', added: 'both added it', 'deleted here': `this task deleted it, ${source} changed it`,
    'deleted there': `this task changed it, ${source} deleted it`,
  };
  const why = (file: (typeof files)[number]) => file.lines ? '; the line merge conflicts'
    : !file.placed ? `; ${formatBytes(file.bytes)}, no room for copies: free space, then run ${directory}/fetch`
    : file.kind !== 'edited' && file.kind !== 'added' ? ''
    : file.bytes > LINE_MERGE_MAX_BYTES ? '; too large to merge line by line' : '; not text';
  const listed = files.slice(0, 20).map((file) => `- ${file.path} (${what[file.kind]}${why(file)})`);
  if (files.length > 20) listed.push(`- … ${files.length - 20} more, all listed in ${directory}/unresolved`);
  return [
    `${label}: ${files.length === 1 ? '1 file' : `${files.length} files`} this task changed ${files.length === 1 ? 'was' : 'were'} also changed by ${source}, and could not be combined automatically:`,
    ...listed,
    `${single ? 'This task\'s copy is' : 'This task\'s copies are in'} ${where}. In ${directory}: base/ holds each file as both started, other/ the other version, conflicts/ a line merge with conflict markers.`,
    'Make each file what it should be with both changes. If this task changed it only as a side effect, use the other version; rebuild a derived file (a database, an index) from the merged inputs. '
      + `Then remove its line from ${directory}/unresolved.`,
  ].join('\n');
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes; let unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function shellQuote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }

/** `$1` is the merge folder, `$2` the incoming side's label; `.work/list`
 * names the files (NUL-separated).
 * Prints `merged|conflict|binary<TAB>file` records, NUL-terminated. A
 * gzip file is merged uncompressed and compressed again. */
const MERGE_SCRIPT = String.raw`set -u
side=$2
cd -- "$1" || exit 3
git=$(command -v git || true)
: > .work/empty
last() { tail -c 1 -- "$1" | od -An -tx1 | tr -d ' \n'; }
text() { local f; for f in "$@"; do [ "$(tr -d '\000' < "$f" | wc -c)" -eq "$(wc -c < "$f")" ] || return 1; done; }
# Both only appended lines: the incoming ones, then this copy's (less those it repeats).
appended() { local out=$1 o=$2 b=$3 t=$4 n
  n=$(wc -c < "$b")
  [ "$(wc -c < "$o")" -gt "$n" ] && [ "$(wc -c < "$t")" -gt "$n" ] || return 1
  if [ "$n" -gt 0 ] && [ "$(last "$b")" != 0a ]; then return 1; fi
  [ "$(last "$o")" = 0a ] && [ "$(last "$t")" = 0a ] || return 1
  cmp -s -n "$n" -- "$b" "$o" && cmp -s -n "$n" -- "$b" "$t" || return 1
  tail -c +$((n + 1)) -- "$t" > .work/tail-t; tail -c +$((n + 1)) -- "$o" > .work/tail-o
  { cat -- "$t"; awk 'NR == FNR { t[FNR] = $0; c = FNR; next } !d && FNR <= c && $0 == t[FNR] { next } { d = 1; print }' .work/tail-t .work/tail-o; } > "$out"
}
# 0 merged, 1 conflict (markers in $5), 2 not text.
merge3() { local out=$1 o=$2 b=$3 t=$4 c=$5 rc
  text "$o" "$b" "$t" || return 2
  if [ -n "$git" ]; then
    "$git" merge-file -p -- "$o" "$b" "$t" > "$out" 2>/dev/null; rc=$?
    [ "$rc" -eq 0 ] && return 0
    [ "$rc" -ge 128 ] && return 2
  fi
  appended "$out" "$o" "$b" "$t" && return 0
  if [ -n "$git" ]; then
    mkdir -p -- "$(dirname -- "$c")"
    "$git" merge-file -p --diff3 -L 'this task' -L 'started from' -L "$side" -- "$o" "$b" "$t" > "$c" 2>/dev/null
  fi
  return 1
}
while IFS= read -r -d '' p; do
  o=".work/mine/$p"; b="base/$p"; t="other/$p"; m=".work/merged/$p"
  [ -f "$b" ] || b=.work/empty
  mkdir -p -- "$(dirname -- "$m")"
  case "$p" in
    *.gz)
      w=".work/plain/$p"; mkdir -p -- "$w"
      rc=2
      if gzip -dc -- "$o" > "$w/o" 2>/dev/null && gzip -dc -- "$t" > "$w/t" 2>/dev/null \
        && { [ "$b" = .work/empty ] && : > "$w/b" || gzip -dc -- "$b" > "$w/b" 2>/dev/null; }; then
        merge3 "$w/m" "$w/o" "$w/b" "$w/t" "conflicts/${'$'}{p%.gz}"; rc=$?
        [ "$rc" -eq 0 ] && { gzip -n -c -- "$w/m" > "$m" || rc=2; }
      fi ;;
    *) merge3 "$m" "$o" "$b" "$t" "conflicts/$p"; rc=$? ;;
  esac
  case "$rc" in 0) s=merged ;; 1) s=conflict ;; *) s=binary ;; esac
  printf '%s\t%s\0' "$s" "$p"
done < .work/list
exit 0`;
