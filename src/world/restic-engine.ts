import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CredentialBroker } from '../autonomy/broker.js';
import type { ResourceAttachment, ResourceChangeSummary, ResourceRevision } from '../domain/types.js';
import type { Store } from '../store/db.js';
import type { ObjectStore } from '../store/objects.js';
import { SYSTEM_JOB_ROOT, jobStatuses, startJob, stopJobs } from './jobs.js';
import { REPOSITORY_ROUTE, RepositoryTokens, parseRepositoryName, repositoryName, repositoryObjectKey, repositoryPassword,
  type RepositoryAccess } from './resource-repository.js';
import { RESTIC_VERSION, resticFailure, runHostRestic, worldResticBinary, type ResticRun } from './restic.js';
import { ensureWorldExcluded } from './secret-exclude.js';
import type { SnapshotVerification } from './resources.js';
import type { World, WorldHandle } from './types.js';
import { isRemoteWorldKind } from './types.js';

/**
 * Project resources saved and restored by restic (wiki features/resource-storage).
 *
 * Every resource is one restic repository behind the server in
 * resource-repository.ts, and a revision is one of its snapshots. A remote
 * sandbox runs restic itself, as a durable job, so its bytes move at the
 * sandbox's own bandwidth and a worker restart only means reattaching to the
 * job; a local world (a worktree or a container's bind mount) is on this host,
 * so restic runs here. Either way it is one standard program doing the whole
 * transfer: chunking, deduplication against every earlier version,
 * encryption, parallel upload, resumption after an interruption.
 */
export const RESTIC_ENGINE = 'restic@1';

export interface RepositoryEndpoints {
  /** Base URL (no trailing slash) at which a remote world reaches the
   * repositories: the edge when one is deployed, else this server. */
  world(handle: WorldHandle): string | undefined;
  /** Whether a world's uploads go from the edge straight into the store,
   * holding none of them in this server's memory. */
  direct?(repository: Repository): Promise<boolean>;
  /** Base URL at which this process reaches it. */
  host(): string | Promise<string>;
}

export interface ResticDeps {
  store: Store;
  broker: CredentialBroker;
  tokens: RepositoryTokens;
  endpoints: RepositoryEndpoints;
  /** Where an attachment's new versions are saved. */
  locationOf(attachment: ResourceAttachment): Promise<string | undefined>;
  objects(attachment: ResourceAttachment, storageLocationId: string | undefined): Promise<ObjectStore>;
  /** restic's cache for commands this host runs. */
  cacheDir?: string;
}

/** What a revision's `sealedRef` holds for this engine. */
export interface ResticRef { snapshot: string; storageLocationId?: string }
export function resticRef(revision: Pick<ResourceRevision, 'sealedRef'>): ResticRef {
  const ref = JSON.parse(revision.sealedRef) as ResticRef;
  if (!/^[0-9a-f]{64}$/.test(ref?.snapshot ?? '')) throw new Error('resource revision has no restic snapshot');
  return ref;
}

/** A resource's repository in one storage location ({@link repositoryName}). */
export interface Repository { attachment: ResourceAttachment; storageLocationId?: string; name: string }

export interface ChangeSet { files: Map<string, '+' | 'M' | '-'>; removedDirectories: string[]; addedDirectories: string[] }

export interface ResticProgress { files: number; totalFiles: number; bytes: number; totalBytes: number }
export interface ResticCapture { snapshot: string; files: number; bytes: number; added: number }

/** Where a resource lives in a world: a directory saved whole, or one file. */
export interface ResticPlace {
  /** A remote world runs restic itself; otherwise this host does. */
  world: World;
  /** Absolute path of the resource in the world. */
  path: string;
  file?: boolean;
}

export interface ResticRunOptions {
  /** Names the durable job, so a retried activity finds the one it started. */
  key: string;
  checkContinue?: () => Promise<void>;
  onProgress?: (progress: ResticProgress) => void;
}

const BIN_DIR = '.karmax-injection/bin';
const CACHE_DIR = '.karmax-injection/restic-cache';
const TOKEN_HOURS = 24;
const POLL_MS = 2_000;
/** A job in a world is polled from this soon, backing off to POLL_MS: most
 * saves and restores of a changed few files take well under a second. */
const FIRST_POLL_MS = 100;
const CONNECTIONS = 8;
/** Each upload through the edge waits on two calls to this server, an ocean
 * away from many sandboxes: measured from E2B (Seattle) to R2 EU, 8, 16 and 32
 * connections uploaded at 46, 55 and 85 MiB/s. The relay keeps 8: it buffers
 * every upload in memory, in slots all worlds share. */
const EDGE_CONNECTIONS = 32;
const RESTORE_CONNECTIONS = 16;
/** A save that finds files changed under it saves again, this many times. */
const SETTLE_ROUNDS = 3;
const VERIFY_MAX_BYTES = 256 * 1024 * 1024;
/** restic tests every node of a snapshot against every restore pattern, so a
 * merge's pattern count multiplies the resource's size. Past this many, a merge
 * restores everything but this world's own changes when they are fewer. */
const MERGE_PATTERNS = 1_000;
/** A creator that has not finished by then has died. */
const INIT_STALE_MS = 2 * 60_000;
const HOST_CORES = Math.max(1, Math.min(2, Math.floor(os.cpus().length / 2)));

export class ResticResources {
  private initialized = new Set<string>();

  constructor(private deps: ResticDeps) {}

  /** The repository new versions of an attachment are saved in. */
  async current(attachment: ResourceAttachment): Promise<Repository> {
    return this.repository(attachment, await this.deps.locationOf(attachment));
  }

  /** The repository holding a revision's snapshot. */
  of(attachment: ResourceAttachment, revision: Pick<ResourceRevision, 'sealedRef'>): Repository {
    return this.repository(attachment, resticRef(revision).storageLocationId);
  }

  repository(attachment: ResourceAttachment, storageLocationId: string | undefined): Repository {
    return { attachment, ...(storageLocationId ? { storageLocationId } : {}), name: repositoryName(attachment.id, storageLocationId) };
  }

  /** A revision's fields for a snapshot saved in `repository`. */
  revisionFields(capture: ResticCapture, repository: Repository) {
    const { storageLocationId } = repository;
    return { engine: RESTIC_ENGINE, sealedRef: JSON.stringify({ snapshot: capture.snapshot, ...(storageLocationId ? { storageLocationId } : {}) }),
      rootDigest: capture.snapshot, bytes: capture.bytes, files: capture.files, ...(storageLocationId ? { storageLocationId } : {}) };
  }

  /** Save `place` as a new snapshot. A file that changes while it is read
   * makes the save run again (incrementally, from what it just stored), so a
   * snapshot never mixes the before and after of a write. */
  async backup(place: ResticPlace, attachment: Repository, options: ResticRunOptions & { parent?: string; quota: boolean }): Promise<ResticCapture> {
    await this.ensureRepository(attachment);
    const superseded: string[] = [];
    let parent = options.parent;
    for (let round = 0; round < SETTLE_ROUNDS; round++) {
      const summary = await this.backupOnce(place, attachment, { ...options, parent, key: `${options.key}:${round}` })
        .catch(async (error) => {
          // What it uploaded before failing is in no index: the next prune deletes it.
          await this.deps.store.kvSet(`restic-prune:${attachment.name}`, String(Date.now()));
          throw error;
        });
      const settled = await this.backupOnce(place, attachment, { ...options, parent: summary.snapshot, dryRun: true, key: `${options.key}:${round}:check` });
      if (!settled.changed) {
        if (superseded.length) await this.forget(attachment, superseded);
        // The finished figures, also for a save shorter than restic's progress interval.
        options.onProgress?.({ files: summary.files, totalFiles: summary.files, bytes: summary.bytes, totalBytes: summary.bytes });
        return { snapshot: summary.snapshot, files: summary.files, bytes: summary.bytes, added: summary.added };
      }
      superseded.push(summary.snapshot);
      parent = summary.snapshot;
    }
    await this.forget(attachment, superseded);
    throw new Error(`${path.posix.basename(place.path)} kept changing while it was being saved; stop whatever is writing to it, then save it again`);
  }

  /** `mirror` also deletes what the snapshot does not have, so the place ends
   * up exactly the snapshot (a laptop's push into a task world). */
  async restore(place: ResticPlace, attachment: Repository, snapshot: string, options: ResticRunOptions & { mirror?: boolean }): Promise<void> {
    const remote = isRemoteWorldKind(place.world.handle.kind);
    const scratch = place.file ? path.posix.join(place.world.handle.root, `.karmax-injection/restore-${crypto.randomBytes(6).toString('hex')}`) : undefined;
    const args = ['restore', snapshot, '--target', scratch ?? place.path, '--no-lock', '--json', '-o', `rest.connections=${RESTORE_CONNECTIONS}`,
      ...(options.mirror && !scratch ? ['--delete'] : [])];
    if (remote) {
      // One job does the restore and puts a single file in place.
      const move = scratch ? `\nshopt -s dotglob nullglob; e=(${quote(scratch)}/*); [ \${#e[@]} -eq 1 ] || { echo "expected one file" >&2; exit 3; }
mkdir -p -- ${quote(path.posix.dirname(place.path))}; rm -rf -- ${quote(place.path)}; mv -f -- "\${e[0]}" ${quote(place.path)}; rm -rf -- ${quote(scratch)}` : '';
      const prepare = scratch ? `rm -rf -- ${quote(scratch)}` : `mkdir -p -- ${quote(place.path)}`;
      const run = await this.inWorld(place.world, attachment, 'read', false, args, { ...options, prefix: prepare, suffix: move });
      if (run.code !== 0) throw resticFailure(run, 'restoring the resource');
      return;
    }
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    else fs.mkdirSync(place.path, { recursive: true });
    const run = await this.onHost(attachment, 'read', false, args, options);
    if (run.code !== 0) throw resticFailure(run, 'restoring the resource');
    if (scratch) {
      const entries = fs.readdirSync(scratch);
      if (entries.length !== 1) throw new Error('restoring the resource failed: expected one file');
      fs.mkdirSync(path.dirname(place.path), { recursive: true });
      fs.rmSync(place.path, { recursive: true, force: true });
      fs.renameSync(path.join(scratch, entries[0]!), place.path);
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }

  /** Create the repository if it does not exist yet: before a client outside
   * any world (the tavya CLI) is given an append grant for it. */
  async prepare(repository: Repository): Promise<void> { await this.ensureRepository(repository); }

  /** Whether `snapshot` was saved in `repository` (its file is listed there). */
  async hasSnapshot(repository: Repository, snapshot: string): Promise<boolean> {
    return /^[0-9a-f]{64}$/.test(snapshot) && Boolean(await this.deps.store.repositoryFile(repository.name, 'snapshots', snapshot));
  }

  /** restic's environment for a client outside any world: the same grant a
   * sandbox gets, for `base` (the edge, else the public URL). */
  clientEnvironment(repository: Repository, base: string, access: 'read' | 'append'): Promise<Record<string, string>> {
    return this.env(repository, base, access, access === 'append');
  }

  /** Save `entry` (`.`: all of it) of a directory on this host: an upload, an import. */
  async backupDirectory(directory: string, attachment: Repository, options: { quota: boolean; parent?: string; entry?: string }): Promise<ResticCapture> {
    await this.ensureRepository(attachment);
    const run = await this.onHost(attachment, 'append', options.quota, [...backupArgs(options.parent), options.entry ?? '.'], { key: 'host', cwd: directory });
    if (run.code !== 0) {
      await this.deps.store.kvSet(`restic-prune:${attachment.name}`, String(Date.now()));
      throw resticFailure(run, 'saving the resource');
    }
    return captureOf(run.stdout);
  }

  /** Files of a snapshot, by path relative to the resource. */
  async files(attachment: Repository, snapshot: string): Promise<Array<{ path: string; bytes: number }>> {
    const run = await this.onHost(attachment, 'read', false, ['ls', '--json', '--no-lock', snapshot], { key: 'host' });
    if (run.code !== 0) throw resticFailure(run, 'listing the resource');
    const files: Array<{ path: string; bytes: number }> = [];
    for (const line of run.stdout.split('\n')) {
      if (!line.startsWith('{')) continue;
      const node = JSON.parse(line);
      if (node.struct_type === 'node' && node.type === 'file') files.push({ path: String(node.path).replace(/^\/+/, ''), bytes: Number(node.size ?? 0) });
    }
    return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  }

  /** What changed between two snapshots of the same repository. Metadata
   * alone (a restored file's new inode or owner) is not a change. */
  async diff(attachment: Repository, from: string, to: string): Promise<Omit<ResourceChangeSummary, 'attachmentId' | 'baseRevisionId'>> {
    const run = await this.onHost(attachment, 'read', false, ['diff', '--json', '--no-lock', from, to], { key: 'host' });
    if (run.code !== 0) throw resticFailure(run, 'comparing versions of the resource');
    let added = 0; let modified = 0; let deleted = 0; let bytes = 0;
    const changedPaths: string[] = [];
    for (const line of run.stdout.split('\n')) {
      if (!line.startsWith('{')) continue;
      const entry = JSON.parse(line);
      if (entry.message_type === 'statistics') { bytes = Number(entry.added?.bytes ?? 0); continue; }
      if (entry.message_type !== 'change' || String(entry.path).endsWith('/')) continue;
      const modifier = String(entry.modifier ?? '');
      if (modifier.includes('+')) added++;
      else if (modifier.includes('-')) deleted++;
      else if (/[MT]/.test(modifier)) modified++;
      else continue;
      if (changedPaths.length < 100) changedPaths.push(String(entry.path).replace(/^\/+/, ''));
    }
    return { added, modified, deleted, bytes, changedPaths };
  }

  /** Every file `to` adds (`+`), changes (`M`) or removes (`-`) relative to
   * `from` (none: an empty resource), and the directories it removes. As
   * {@link diff}, metadata alone is not a change. */
  async changeSet(attachment: Repository, from: string | undefined, to: string): Promise<ChangeSet> {
    const files = new Map<string, '+' | 'M' | '-'>();
    const removedDirectories: string[] = [];
    const addedDirectories: string[] = [];
    if (!from) {
      const directories = new Set<string>();
      for (const file of await this.files(attachment, to)) {
        files.set(file.path, '+');
        for (const directory of ancestors(file.path)) directories.add(directory);
      }
      return { files, removedDirectories, addedDirectories: [...directories] };
    }
    const run = await this.onHost(attachment, 'read', false, ['diff', '--json', '--no-lock', from, to], { key: 'host' });
    if (run.code !== 0) throw resticFailure(run, 'comparing versions of the resource');
    for (const line of run.stdout.split('\n')) {
      if (!line.startsWith('{')) continue;
      const entry = JSON.parse(line);
      if (entry.message_type !== 'change') continue;
      const modifier = String(entry.modifier ?? '');
      const relative = String(entry.path).replace(/^\/+/, '');
      if (relative.endsWith('/')) {
        if (modifier.includes('-')) removedDirectories.push(relative.slice(0, -1));
        else if (modifier.includes('+')) addedDirectories.push(relative.slice(0, -1));
        continue;
      }
      if (modifier.includes('+')) files.set(relative, '+');
      else if (modifier.includes('-')) files.set(relative, '-');
      else if (/[MT]/.test(modifier)) files.set(relative, 'M');
    }
    return { files, removedDirectories, addedDirectories };
  }

  /** Make `paths` of a directory-shaped `place` what they are in `snapshot`,
   * delete `deletions`, then the `removedDirectories` left empty. Nothing
   * else in the place is touched: in particular not `own`, the place's own
   * changes, which a merge keeps.
   *
   * restic tests every node of the snapshot against every pattern it is given
   * (pramana#3: 706,916 patterns over 777,367 files made no progress in hours),
   * so the patterns stay few: a file inside a directory the snapshot adds goes
   * with that whole directory, and when even then there are more than
   * {@link MERGE_PATTERNS} and the place's own changes are fewer, everything
   * but those is restored instead. A file that both sides changed is the
   * same on both (the caller refuses a conflict), so restoring it is a no-op. */
  async applyPaths(place: ResticPlace, attachment: Repository, snapshot: string,
    change: { paths: string[]; deletions: string[]; removedDirectories: string[]; addedDirectories?: string[]; own?: ChangeSet },
    options: ResticRunOptions): Promise<void> {
    const all = [...change.paths, ...change.deletions, ...change.removedDirectories];
    const awkward = all.find((file) => /[\n\r]/.test(file) || file.split('/').includes('..'));
    if (awkward !== undefined) throw new Error(`cannot merge a file named ${JSON.stringify(awkward)}`);
    // Named by the job's key, so a retried merge issues the same command and
    // finds the restore an earlier attempt left running.
    const lists = `.karmax-injection/merge-${crypto.createHash('sha256').update(options.key).digest('hex').slice(0, 12)}`;
    const root = place.world.handle.root;
    const write = async (name: string, value: string) => {
      await place.world.writeFile(`${lists}/${name}`, value);
      return path.posix.join(root, lists, name);
    };
    try {
      if (change.paths.length) {
        const include = collapse(change.paths, new Set(change.addedDirectories ?? []));
        let exclude: string[] | undefined;
        if (include.length > MERGE_PATTERNS && change.own) {
          // A directory of the place's own may go whole only if nothing in it changed in the snapshot.
          const touched = new Set([...all, ...all.flatMap(ancestors)]);
          const own = collapse(change.own.files.keys(), new Set([...change.own.addedDirectories, ...change.own.removedDirectories]
            .filter((directory) => !touched.has(directory))));
          if (own.length < include.length) exclude = own;
        }
        const selection = exclude
          // Unchanged files are left alone: size and mtime say so, as they do for a save (backupArgs).
          ? ['--exclude-file', await write('exclude', patternList(exclude)), '--overwrite', 'if-changed']
          : ['--include-file', await write('include', patternList(include))];
        const args = ['restore', snapshot, '--target', place.path, ...selection, '--no-lock', '--json',
          '-o', `rest.connections=${RESTORE_CONNECTIONS}`];
        const run = isRemoteWorldKind(place.world.handle.kind)
          ? await this.inWorld(place.world, attachment, 'read', false, args, options)
          : await this.onHost(attachment, 'read', false, args, options);
        if (run.code !== 0) throw resticFailure(run, 'merging the resource');
      }
      if (change.deletions.length || change.removedDirectories.length) {
        const deletions = await write('delete', change.deletions.map((file) => `${file}\0`).join(''));
        // Deepest first, so a removed tree goes once it is empty; a directory still holding files stays.
        const directories = await write('rmdir', [...change.removedDirectories].sort((a, b) => b.length - a.length).map((dir) => `${dir}\0`).join(''));
        const removed = await place.world.exec('bash', ['-c', `set -e; cd -- "$1"; xargs -0 -r rm -f -- < "$2"; xargs -0 -r rmdir --ignore-fail-on-non-empty -- < "$3" 2>/dev/null || true`,
          'merge', place.path, deletions, directories], { cwd: root, timeoutMs: 10 * 60_000 });
        if (removed.code !== 0) throw new Error(`merging the resource failed: ${(removed.stderr || removed.stdout).trim().slice(0, 300)}`);
      }
    } finally {
      await place.world.exec('rm', ['-rf', '--', lists], { cwd: root }).catch(() => undefined);
    }
  }

  /** Read back files of a snapshot, decrypting and checking every byte, a page at a time. */
  async verify(attachment: Repository, snapshot: string, offset: number, limit: number): Promise<SnapshotVerification> {
    let files: Array<{ path: string; bytes: number }>;
    // restic's errors may name URLs and paths: report only that it failed.
    try { files = await this.files(attachment, snapshot); }
    catch { return { status: 'failed' as const, manifestVerified: false, offset, verifiedFiles: 0, verifiedBytes: 0, files: [], issue: 'unreadable-or-corrupt' as const }; }
    const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
    const base = { manifestVerified: true, rootDigest: snapshot, totalFiles: files.length, totalBytes, offset,
      verifiedFiles: 0, verifiedBytes: 0, files: [] as Array<{ path: string; bytes: number; sha256: string }> };
    if (offset > files.length) return { ...base, status: 'failed' as const, issue: 'invalid-offset' as const };
    // Nothing counts as verified unless every file of the page read back.
    const failed = () => ({ ...base, verifiedFiles: 0, verifiedBytes: 0, files: [], status: 'failed' as const, issue: 'unreadable-or-corrupt' as const });
    const page: typeof files = [];
    let pageBytes = 0;
    let limited = false;
    for (const file of files.slice(offset, offset + limit)) {
      if (pageBytes + file.bytes > VERIFY_MAX_BYTES) { limited = true; break; }
      page.push(file); pageBytes += file.bytes;
    }
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-verify-'));
    try {
      if (page.length) {
        const includes = path.join(scratch, 'include');
        fs.writeFileSync(includes, page.map((file) => `/${file.path.replace(/[\\*?[]/g, '\\$&')}`).join('\n'));
        const run = await this.onHost(attachment, 'read', false, ['restore', snapshot, '--target', path.join(scratch, 'files'),
          '--include-file', includes, '--no-lock', '--json'], { key: 'host' });
        if (run.code !== 0) return failed();
      }
      for (const file of page) {
        const data = fs.readFileSync(path.join(scratch, 'files', file.path));
        if (data.length !== file.bytes) return failed();
        base.files.push({ path: file.path, bytes: file.bytes, sha256: crypto.createHash('sha256').update(data).digest('hex') });
        base.verifiedFiles++; base.verifiedBytes += file.bytes;
      }
    } catch {
      return failed();
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
    const end = offset + base.verifiedFiles;
    return { ...base, status: offset === 0 && end === files.length ? 'complete' as const : 'partial' as const,
      ...(end < files.length ? { nextOffset: end } : {}), ...(limited ? { issue: 'byte-limit' as const } : {}) };
  }

  /** Whether a world is saving or restoring a resource right now (a job
   * started within the last six hours that no waiter has finished with). */
  async busy(): Promise<boolean> {
    const cutoff = Date.now() - 6 * 3_600_000;
    return (await this.deps.store.kvEntries('restic-job:')).some((entry) => {
      try { return Number(JSON.parse(entry.value).at ?? 0) > cutoff; } catch { return false; }
    });
  }

  /** Drop snapshots; their data goes with the next {@link prune}. */
  async forget(attachment: Repository, snapshots: string[]): Promise<void> {
    const present = new Set((await this.deps.store.listRepositoryFiles(attachment.name, 'snapshots')).map((file) => file.name));
    const gone = snapshots.filter((snapshot) => present.has(snapshot));
    if (!gone.length) return;
    const run = await this.onHost(attachment, 'admin', false, ['forget', '--json', ...gone], { key: 'host' });
    if (run.code !== 0) throw resticFailure(run, 'forgetting resource versions');
    await this.deps.store.kvSet(`restic-prune:${attachment.name}`, String(Date.now()));
  }

  /** Delete the data no snapshot uses. Waits out a save in progress, which
   * holds the repository; locks left by a world that died expire by themselves. */
  async prune(attachment: Repository): Promise<void> {
    const run = await this.onHost(attachment, 'admin', false, ['prune', '--max-unused', '5%', '--retry-lock', '1m'], { key: 'host' });
    if (run.code !== 0) throw resticFailure(run, 'pruning the resource');
    await this.deps.store.kvDelete(`restic-prune:${attachment.name}`);
  }

  /** Every repository of the attachment goes, with it. */
  async removeRepositories(attachment: ResourceAttachment): Promise<void> {
    const names = new Set((await this.deps.store.attachmentRepositoryFiles(attachment.id)).map((file) => file.repository));
    for (const name of names) await this.removeRepository(this.repository(attachment, parseRepositoryName(name)?.storageLocationId));
  }

  private async removeRepository(repository: Repository): Promise<void> {
    const objects = await this.deps.objects(repository.attachment, repository.storageLocationId);
    for (const file of await this.deps.store.listRepositoryFiles(repository.name)) {
      if (file.kind !== 'locks') await objects.delete(repositoryObjectKey(repository.name, file.kind, file.name));
      await this.deps.store.deleteRepositoryFile(repository.name, file.kind, file.name);
    }
    this.initialized.delete(repository.name);
    await this.deps.store.kvDelete(`restic-prune:${repository.name}`);
  }

  /** Create the repository once. Concurrent saves of a new resource wait for
   * one creator: two `restic init`s would leave the loser's key beside the
   * winner's config, and restic, trying that key first, could not open it. */
  private async ensureRepository(attachment: Repository): Promise<void> {
    if (this.initialized.has(attachment.name)) return;
    const claimKey = `restic-init:${attachment.name}`;
    const owner = crypto.randomUUID();
    const deadline = Date.now() + 5 * 60_000;
    while (!(await this.deps.store.repositoryFile(attachment.name, 'config', 'config'))) {
      if (Date.now() > deadline) throw new Error('creating the resource repository timed out');
      const held = await this.deps.store.kvGet(claimKey);
      const stale = held !== undefined && Date.now() - Number(JSON.parse(held).at ?? 0) > INIT_STALE_MS;
      const mine = JSON.stringify({ owner, at: Date.now() });
      if ((held === undefined || stale) && await this.deps.store.kvCompareAndSet(claimKey, held, mine)) {
        try {
          // restic writes the config last: without one, whatever is there is
          // an init that stopped half-way.
          await this.removeRepository(attachment);
          const run = await this.onHost(attachment, 'admin', false, ['init', '--json'], { key: 'host', create: true });
          if (run.code !== 0) throw resticFailure(run, 'creating the resource repository');
        } finally { await this.deps.store.kvCompareAndSet(claimKey, mine, undefined); }
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    this.initialized.add(attachment.name);
  }

  private async backupOnce(place: ResticPlace, attachment: Repository, options: ResticRunOptions & { parent?: string;
    quota: boolean; dryRun?: boolean }): Promise<ResticCapture & { changed: boolean }> {
    // A one-file resource is its content: a link is saved as what it points to.
    const file = place.file ? await this.realPath(place) : undefined;
    const directory = file ? path.posix.dirname(file) : place.path;
    const remote = isRemoteWorldKind(place.world.handle.kind);
    const connections = remote && await this.deps.endpoints.direct?.(attachment) ? EDGE_CONNECTIONS : CONNECTIONS;
    const args = [...backupArgs(options.parent, connections), ...(options.dryRun ? ['--dry-run'] : []), file ? path.posix.basename(file) : '.'];
    const progress = options.dryRun ? {} : { onProgress: options.onProgress };
    const run = remote
      ? await this.inWorld(place.world, attachment, 'append', options.quota, args, { ...options, ...progress, cwd: directory })
      : await this.onHost(attachment, 'append', options.quota, args, { ...options, ...progress, cwd: directory });
    if (run.code !== 0) throw resticFailure(run, 'saving the resource');
    const summary = summaryOf(run.stdout);
    return { ...captureOf(run.stdout, options.dryRun), changed: Number(summary.files_new ?? 0) + Number(summary.files_changed ?? 0) > 0 };
  }

  private async realPath(place: ResticPlace): Promise<string> {
    if (!isRemoteWorldKind(place.world.handle.kind)) return fs.realpathSync(place.path);
    const resolved = await place.world.exec('readlink', ['-f', '--', place.path], { cwd: place.world.handle.root, timeoutMs: 30_000 });
    if (resolved.code !== 0 || !resolved.stdout.trim()) throw new Error(`could not resolve ${place.path}: ${resolved.stderr.trim()}`);
    return resolved.stdout.trim();
  }

  private async env(repository: Repository, base: string, access: RepositoryAccess, quota: boolean, create = false): Promise<Record<string, string>> {
    const token = await this.deps.tokens.mint({ repository: repository.name, access, quota, expiresAt: Date.now() + TOKEN_HOURS * 3_600_000 });
    return { RESTIC_REPOSITORY: `rest:${base.replace(/\/+$/, '')}${REPOSITORY_ROUTE}${repository.name}/`, RESTIC_REST_USERNAME: 'tavya',
      RESTIC_REST_PASSWORD: token, RESTIC_PASSWORD: await repositoryPassword(this.deps.broker, repository.attachment, create), RESTIC_PROGRESS_FPS: '0.5' };
  }

  private async onHost(attachment: Repository, access: RepositoryAccess, quota: boolean, args: string[],
    options: ResticRunOptions & { cwd?: string; create?: boolean }): Promise<ResticRun> {
    // Half of a small host at most: the app serves everyone meanwhile.
    const env = { ...await this.env(attachment, await this.deps.endpoints.host(), access, quota, options.create),
      ...(this.deps.cacheDir ? { RESTIC_CACHE_DIR: this.deps.cacheDir } : {}), GOMAXPROCS: String(HOST_CORES) };
    const controller = new AbortController();
    let cancelled: unknown;
    const watch = options.checkContinue && setInterval(() => {
      options.checkContinue!().catch((error) => { cancelled = error; controller.abort(); });
    }, POLL_MS);
    try {
      // A cache per repository, and old ones removed (unused for 30 days).
      const run = await runHostRestic([...(this.deps.cacheDir ? ['--cleanup-cache'] : ['--no-cache']), ...args], env, { cwd: options.cwd, signal: controller.signal,
        onLine: (line) => { const progress = progressOf(line); if (progress) options.onProgress?.(progress); } })
        .catch((error) => { if (cancelled) throw cancelled; throw error; });
      if (cancelled) throw cancelled;
      return run;
    } finally { if (watch) clearInterval(watch); }
  }

  /** Run restic in a remote world as a durable job. An activity retried while
   * the job still runs (a worker restart) waits for that same job, found by
   * `options.key`; one that finds it finished runs restic again, which then
   * has everything already stored. */
  private async inWorld(world: World, attachment: Repository, access: RepositoryAccess, quota: boolean, args: string[],
    options: ResticRunOptions & { cwd?: string; prefix?: string; suffix?: string }): Promise<ResticRun> {
    const base = this.deps.endpoints.world(world.handle);
    if (!base) throw new Error('this world cannot reach the resource store (no public URL is configured)');
    const binary = await this.worldBinary(world, base);
    const command = `set -e\n${options.prefix ? `${options.prefix}\n` : ''}${options.cwd ? `cd -- ${quote(options.cwd)}\n` : ''}`
      + `${quote(binary)} ${args.map(quote).join(' ')}${options.suffix ?? ''}`;
    const recordKey = `restic-job:${world.handle.id}:${options.key}`;
    const digest = crypto.createHash('sha256').update(command).digest('hex');
    let recorded = await this.deps.store.kvGet(recordKey);
    let job: string | undefined;
    let earlier: string | undefined;
    try {
      const value = JSON.parse(recorded ?? '{}') as { job?: string; generation?: number; digest?: string };
      if (value.generation === (world.handle.generation ?? 1) && value.job
        && (await jobStatuses(world, [value.job], { root: SYSTEM_JOB_ROOT }))[0]?.state === 'running') {
        if (value.digest === digest) job = value.job; else earlier = value.job;
      }
    } catch { /* none */ }
    // An attempt whose worker died left its restic running, with other
    // arguments: two would compete for the sandbox and write the same files.
    if (earlier) await stopJobs(world, [earlier], SYSTEM_JOB_ROOT);
    if (!job) {
      const env = { ...await this.env(attachment, base, access, quota),
        RESTIC_CACHE_DIR: path.posix.join(world.handle.root, CACHE_DIR) };
      job = (await startJob(world, { command, cwd: world.handle.root, env, root: SYSTEM_JOB_ROOT })).id;
      recorded = JSON.stringify({ job, generation: world.handle.generation ?? 1, digest, at: Date.now() });
      await this.deps.store.kvSet(recordKey, recorded);
    }
    const forget = () => this.deps.store.kvCompareAndSet(recordKey, recorded, undefined).catch(() => false);
    try {
      for (let wait = FIRST_POLL_MS; ; wait = Math.min(wait * 2, POLL_MS)) {
        await options.checkContinue?.();
        const [status] = await jobStatuses(world, [job], { root: SYSTEM_JOB_ROOT, tailLines: 4 });
        for (const line of (status?.tail ?? '').split('\n').reverse()) {
          const progress = progressOf(line);
          if (progress) { options.onProgress?.(progress); break; }
        }
        if (status?.state === 'exited') {
          const log = await world.exec('bash', ['-c', `tail -c 1048576 ${quote(`${SYSTEM_JOB_ROOT}/${job}/log`)}`],
            { cwd: world.handle.root, timeoutMs: 30_000 });
          await forget();
          return { code: status.exitCode ?? -1, stdout: log.stdout, stderr: log.stdout };
        }
        if (status?.state !== 'running') {
          await forget();
          throw new Error('restic stopped without finishing (the sandbox was restarted); it resumes from what it stored when retried');
        }
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    } catch (error) {
      // Cancelled: the job stops with the activity that waited on it.
      if (await forget()) await stopJobs(world, [job], SYSTEM_JOB_ROOT).catch(() => undefined);
      throw error;
    }
  }

  /** restic in a remote world: fetched once from this server and checked against its pinned digest. */
  private async worldBinary(world: World, base: string): Promise<string> {
    const relative = `${BIN_DIR}/restic-${RESTIC_VERSION}`;
    const absolute = path.posix.join(world.handle.root, relative);
    // Finished platform jobs are kept a day (another waiter may still read one).
    const probe = await world.exec('bash', ['-c', `find ${SYSTEM_JOB_ROOT} -mindepth 1 -maxdepth 1 -mmin +1440 -exec rm -rf {} + 2>/dev/null; `
      + `test -x ${quote(relative)} && echo present || uname -m`], { cwd: world.handle.root, timeoutMs: 30_000 });
    if (probe.stdout.trim() === 'present') return absolute;
    const arch = ({ x86_64: 'amd64', amd64: 'amd64', aarch64: 'arm64', arm64: 'arm64' } as Record<string, string>)[probe.stdout.trim()];
    const binary = arch ? worldResticBinary(arch) : undefined;
    if (!binary) throw new Error(`restic is not available for this world (${probe.stdout.trim() || probe.stderr.trim() || 'unknown architecture'})`);
    await ensureWorldExcluded(world, '.karmax-injection').catch(() => undefined);
    const url = `${base.replace(/\/+$/, '')}${REPOSITORY_ROUTE}restic/${RESTIC_VERSION}/linux-${arch}`;
    const fetched = await world.exec('bash', ['-c', `set -e; mkdir -p ${BIN_DIR}; t=${BIN_DIR}/.restic-$$
if command -v curl >/dev/null; then curl -fsSL --retry 3 "$1" -o "$t"
elif command -v wget >/dev/null; then wget -q -O "$t" "$1"
else node -e 'fetch(process.argv[1]).then(async r=>{if(!r.ok)throw new Error(r.status);require("fs").writeFileSync(process.argv[2],Buffer.from(await r.arrayBuffer()))})' "$1" "$t"; fi
got=$(sha256sum "$t" 2>/dev/null | cut -d' ' -f1 || node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$t")
[ "$got" = "$2" ] || { rm -f "$t"; echo "restic download does not match its digest" >&2; exit 1; }
chmod +x "$t"; mv -f "$t" ${quote(relative)}`, 'restic-fetch', url, binary.sha256], { cwd: world.handle.root, timeoutMs: 5 * 60_000 });
    if (fetched.code !== 0) throw new Error(`could not install restic in the world: ${(fetched.stderr || fetched.stdout).trim().slice(0, 300)}`);
    return absolute;
  }
}

function backupArgs(parent?: string, connections = CONNECTIONS): string[] {
  // Inode and ctime differ in every world a resource is restored into; the
  // size and nanosecond mtime restic restores are what say a file is
  // unchanged, so a restored world is not read again in full. (An edit that
  // keeps both, by setting the old mtime back, would go unnoticed.)
  return ['backup', '--json', '--host', 'tavya', '--ignore-inode', '--exclude', '.git', '--exclude', '.karmax-injection',
    '-o', `rest.connections=${connections}`, ...(parent ? ['--parent', parent] : [])];
}

/** A restic pattern matching exactly `file`: glob characters escaped, `$`
 * doubled (pattern files expand variables) and spaces in a class (lines are
 * trimmed). */
/** Every directory a relative path is inside, outermost first. */
function ancestors(file: string): string[] {
  const out: string[] = [];
  for (let i = file.indexOf('/'); i > 0; i = file.indexOf('/', i + 1)) out.push(file.slice(0, i));
  return out;
}

/** `files`, each given as the outermost of `directories` it is inside (if
 * any): one restic pattern for a whole tree. Sorted, without repeats. */
function collapse(files: Iterable<string>, directories: Set<string>): string[] {
  const out = new Set<string>();
  for (const file of files) out.add(ancestors(file).find((directory) => directories.has(directory)) ?? file);
  return [...out].sort();
}

function patternList(files: string[]): string {
  return files.map((file) => `/${includePattern(file)}\n`).join('');
}

function includePattern(file: string): string {
  return file.replace(/[\\*?[]/g, (c) => `\\${c}`).replace(/\$/g, '$$$$').replace(/\s/g, (c) => `[${c}]`);
}

function summaryOf(stdout: string): Record<string, unknown> {
  for (const line of stdout.split('\n').reverse()) {
    if (!line.startsWith('{')) continue;
    try { const value = JSON.parse(line); if (value.message_type === 'summary') return value; } catch { /* partial line */ }
  }
  throw new Error('restic did not report a summary');
}

function captureOf(stdout: string, dryRun = false): ResticCapture {
  const summary = summaryOf(stdout);
  const snapshot = String(summary.snapshot_id ?? '');
  if (!dryRun && !/^[0-9a-f]{64}$/.test(snapshot)) throw new Error('restic did not report a snapshot');
  return { snapshot, files: Number(summary.total_files_processed ?? 0), bytes: Number(summary.total_bytes_processed ?? 0),
    added: Number(summary.data_added_packed ?? summary.data_added ?? 0) };
}

function progressOf(line: string): ResticProgress | undefined {
  if (!line.startsWith('{"message_type":"status"')) return undefined;
  try {
    const status = JSON.parse(line);
    return { files: Number(status.files_done ?? status.files_restored ?? 0), totalFiles: Number(status.total_files ?? 0),
      bytes: Number(status.bytes_done ?? status.bytes_restored ?? 0), totalBytes: Number(status.total_bytes ?? 0) };
  } catch { return undefined; }
}

function quote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
